/**
 * Cloudflare Worker —— DeepSeek 代理
 *
 * 为什么需要它：
 *   1. DeepSeek 的 Key 绝对不能写进前端代码（GitHub 上有机器人全天扫描 sk- 开头的字符串，
 *      一旦提交进仓库，几分钟内就会被盗刷）。
 *   2. 浏览器直接请求 api.deepseek.com 会撞 CORS，而且会暴露你的 Key。
 *   3. Key 放在 Worker 的环境变量里（加密存储），前端只见 Worker 地址。
 *
 * 接口：
 *   POST /api/llm   转发到 DeepSeek Chat Completions（支持 stream:true 直通 SSE）
 *   GET  /api/health  健康检查
 */

const UPSTREAM = 'https://api.deepseek.com/chat/completions';

const CORS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '86400',
};

function json(body, status = 200, extra = {}) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json; charset=utf-8', ...CORS, ...extra },
  });
}

/** 简单的每 IP 冷却，防止被打爆账单 */
const hits = new Map();
function rateLimited(ip) {
  const now = Date.now();
  const arr = (hits.get(ip) || []).filter((t) => now - t < 1000);
  arr.push(now);
  hits.set(ip, arr);
  if (hits.size > 500) hits.clear();
  return arr.length > 3; // 每秒最多 3 次，够两个人同时打牌了
}

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);

    if (request.method === 'OPTIONS') {
      return new Response(null, { status: 204, headers: CORS });
    }

    if (url.pathname === '/api/health') {
      return json({
        ok: true,
        hasKey: !!env.DEEPSEEK_API_KEY,
        lockEnabled: !!env.PROXY_TOKEN,
        model: env.MODEL || 'deepseek-chat',
      });
    }

    if (url.pathname !== '/api/llm') {
      return json({ error: 'Not found. Use POST /api/llm' }, 404);
    }

    if (request.method !== 'POST') {
      return json({ error: 'Method not allowed' }, 405);
    }

    // 口令校验（可选）：如果 Worker 配了 PROXY_TOKEN，前端必须带同样的 Authorization
    if (env.PROXY_TOKEN) {
      const auth = request.headers.get('Authorization') || '';
      if (auth !== `Bearer ${env.PROXY_TOKEN}`) {
        return json({ error: 'Unauthorized: bad proxy token' }, 401);
      }
    }

    const ip = request.headers.get('CF-Connecting-IP') || 'unknown';
    if (rateLimited(ip)) {
      return json({ error: 'Rate limited, slow down' }, 429);
    }

    let payload;
    try {
      payload = await request.json();
    } catch (e) {
      return json({ error: 'Invalid JSON body' }, 400);
    }

    // Key 优先级：Worker 环境变量 > 请求自带（本地调试用，务必不要用于公开部署）
    let apiKey = env.DEEPSEEK_API_KEY;
    if (!apiKey) {
      const incoming = request.headers.get('X-DeepSeek-Key');
      if (incoming) apiKey = incoming;
    }
    if (!apiKey) {
      return json({ error: 'Worker 未配置 DEEPSEEK_API_KEY。用 wrangler secret put DEEPSEEK_API_KEY 设置。' }, 500);
    }

    const body = {
      model: payload.model || env.MODEL || 'deepseek-chat',
      messages: payload.messages || [],
      stream: !!payload.stream,
    };
    if (payload.temperature != null) body.temperature = payload.temperature;
    if (payload.max_tokens != null) body.max_tokens = payload.max_tokens;

    // 安全兜底：限制长度，避免单次请求烧掉太多 token
    body.max_tokens = Math.min(body.max_tokens || 64, 512);
    if (JSON.stringify(body.messages).length > 8000) {
      return json({ error: 'Messages too long' }, 413);
    }

    try {
      const upstream = await fetch(UPSTREAM, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        body: JSON.stringify(body),
      });

      if (!upstream.ok) {
        const text = await upstream.text().catch(() => '');
        return json(
          { error: `Upstream ${upstream.status}`, detail: text.slice(0, 300) },
          upstream.status === 401 ? 401 : 502,
        );
      }

      // SSE 直通
      if (body.stream && upstream.body) {
        return new Response(upstream.body, {
          status: 200,
          headers: {
            'Content-Type': 'text/event-stream; charset=utf-8',
            'Cache-Control': 'no-cache',
            ...CORS,
          },
        });
      }

      const data = await upstream.json();
      return json(data);
    } catch (e) {
      return json({ error: 'Upstream request failed', detail: String(e && e.message) }, 502);
    }
  },
};
