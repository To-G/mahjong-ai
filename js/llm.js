/**
 * llm.js —— LLM「人格层」
 *
 * 关键设计：LLM 不负责出牌决策（那是 ai.js 的活）。
 * 它只负责「说话」——吐槽、吹牛、懊恼、点评你打的牌。
 * 这样即使大模型慢半拍、或者你压根没配 Key，牌局照样正常跑。
 *
 * Key 的安全：前端永远不直接拿 DeepSeek Key，
 * 而是请求 Cloudflare Worker 代理（ENDPOINT），Key 存在 Worker 的环境变量里。
 * 如果你本地自用，也可以在设置面板里填 Key 走本地代理。
 */

const LS_KEY = 'mj_llm_config';

/** 默认配置 */
export const defaultConfig = () => ({
  enabled: false,          // 是否启用 LLM 发言
  endpoint: '',            // Worker 地址，例如 https://mahjong-ai.xxx.workers.dev/api/llm
  token: '',               // Worker 的访问口令（可选，和 Worker 里 PROXY_TOKEN 对应）
  model: 'deepseek-chat',
  temperature: 1.0,
  decisionMode: false,     // true = 让 LLM 直接决定出牌（实验功能，会慢）
  maxConcurrent: 1,
});

export function loadConfig() {
  try {
    const raw = localStorage.getItem(LS_KEY);
    if (!raw) return defaultConfig();
    return { ...defaultConfig(), ...JSON.parse(raw) };
  } catch (e) {
    return defaultConfig();
  }
}

export function saveConfig(cfg) {
  try {
    localStorage.setItem(LS_KEY, JSON.stringify(cfg));
  } catch (e) {
    /* 忽略隐私模式下的写入失败 */
  }
}

/* ------------------------------------------------------------------ */
/*  离线台词库（LLM 不可用时的降级方案，保证“有话可说”）              */
/* ------------------------------------------------------------------ */

export const PERSONAS = {
  chatter: {
    name: '圆圆',
    title: '话痨妹妹',
    color: '#e0669b',
    style: '活泼话多，爱起哄，喜欢一边打一边点评别人，偶尔撒娇',
    lines: {
      draw: ['诶嘿～这张我喜欢', '摸到宝啦', '手感来了哦'],
      discard: ['这张不要了啦', '给你给你～', '嗯……就它吧'],
      pung: ['碰！这我可不客气', '碰一个～谢谢哦'],
      kong: ['杠！开杠有喜', '哈哈杠上开花要不要'],
      win: ['胡啦！不好意思收钱～', '嘿嘿，我胡了哦'],
      lose: ['哎呀被你抢先了', '呜呜我的牌', '不算不算，下一把'],
      ron: ['这张我等好久了！', '胡！谢谢你 please～'],
      taunt: ['你手上的牌看着不太妙诶', '嘿嘿，我快要好了哦', '别紧张别紧张～'],
    },
  },
  hothead: {
    name: '阿伟',
    title: '暴躁老哥',
    color: '#d9534f',
    style: '火爆脾气，打错牌就骂自己，放炮就拍桌子，嘴上不服输',
    lines: {
      draw: ['这才像话！', '终于来了！', '行行行，还行'],
      discard: ['晦气，扔了', '这张留着过年？', '去去去'],
      pung: ['碰！早该来了', '碰了碰了'],
      kong: ['杠！痛快！', '开杠！'],
      win: ['胡！！看到没', '这才叫打牌！'],
      lose: ['靠，这都能胡？', '你把牌吃了？这也太假了', '不算！下把弄你'],
      ron: ['胡！就等你这张！', '接着！'],
      taunt: ['快点行不行，磨磨唧唧的', '你那牌我看都头疼', '小心点，我要动了'],
    },
  },
  prof: {
    name: '老周',
    title: '冷静算牌男',
    color: '#3b7ddd',
    style: '话不多，一针见血，喜欢用一句话点破牌局，带点书卷气',
    lines: {
      draw: ['嗯，有用。', '来了。', '接上。'],
      discard: ['这张没用了。', '留着是累赘。', '走。'],
      pung: ['碰。', '碰了。'],
      kong: ['杠。', '杠一手。'],
      win: ['胡了。承让。', '和。'],
      lose: ['意料之中……好吧不全然。', '记下了。', '下盘调整。'],
      ron: ['胡。', '这张我有等。'],
      taunt: ['中后期了，出牌小心点。', '这张牌要谨慎。', '你的拆牌有点急。'],
    },
  },
};

export function fallbackLine(personaKey, kind, ctx = {}) {
  const p = PERSONAS[personaKey] || PERSONAS.chatter;
  const arr = p.lines[kind] || p.lines.discard || ['……'];
  let s = arr[Math.floor(Math.random() * arr.length)];
  if (ctx.tileName) s = s.replace('{tile}', ctx.tileName);
  return s;
}

/* ------------------------------------------------------------------ */
/*  LLM 客户端                                                          */
/* ------------------------------------------------------------------ */

export class LLMBrain {
  constructor(cfg = null) {
    this.cfg = cfg || loadConfig();
    this.queue = Promise.resolve();
    this.failures = 0;
    this.disabled = false;
  }

  setConfig(cfg) {
    this.cfg = { ...defaultConfig(), ...cfg };
  }

  get usable() {
    return !this.disabled && this.cfg.enabled && !!this.cfg.endpoint;
  }

  /** 串行化请求，避免瞬间打爆 API */
  enqueue(task) {
    const run = this.queue.then(task, task);
    this.queue = run.catch(() => {});
    return run;
  }

  async chat(messages, { maxTokens = 60, temperature = null } = {}) {
    if (!this.usable) throw new Error('LLM 未启用');
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 12000);
    try {
      const res = await fetch(this.cfg.endpoint, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          ...(this.cfg.token ? { Authorization: `Bearer ${this.cfg.token}` } : {}),
        },
        body: JSON.stringify({
          model: this.cfg.model,
          messages,
          max_tokens: maxTokens,
          temperature: temperature ?? this.cfg.temperature,
          stream: false,
        }),
        signal: controller.signal,
      });
      if (!res.ok) {
        const txt = await res.text().catch(() => '');
        throw new Error(`HTTP ${res.status} ${txt.slice(0, 120)}`);
      }
      const data = await res.json();
      const content = data?.choices?.[0]?.message?.content;
      if (!content) throw new Error('返回内容为空');
      this.failures = 0;
      return String(content).trim();
    } catch (e) {
      this.failures++;
      if (this.failures >= 3) this.disabled = true; // 连续失败后彻底降级，避免一直卡
      throw e;
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * 生成一句牌桌发言（异步、绝不影响出牌）
   * @param personaKey 性格 key
   * @param ctx { tileName, action, myHandText, visible, leadInfo, promptHint }
   * @returns Promise<string>
   */
  speak(personaKey, ctx) {
    const fb = () => fallbackLine(personaKey, ctx.kind, ctx);
    if (!this.usable) return Promise.resolve(fb());
    const persona = PERSONAS[personaKey] || PERSONAS.chatter;
    const system = [
      `你在打四川麻将（血战到底），你是${persona.name}，性格：${persona.style}。`,
      '规则约束：所有发言必须是中文口语，一句不超过 20 个字，不要解释规则，不要用引号、不要带标点结尾的车轱辘话、不要说“我打出了一张X”这种废话。',
      '只输出这一句话本身，不要加任何前缀。',
    ].join('\n');
    const user = `【当前情况】${ctx.describe || ''}\n【你要做的事】${ctx.intent || '说一句符合你性格的话'}`;
    return this.enqueue(() => this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { maxTokens: 48 },
    )).then((s) => {
      const clean = s.replace(/^["'“”「」]|[，。！？、]*$/g, '').trim();
      return clean || fb();
    }).catch(() => fb());
  }

  /**
   * 实验功能：让 LLM 直接决定打哪张牌
   * @param ctx { hand: string, options: string[], missingSuit: string }
   * @returns Promise<number|null> 返回牌 index 或 null（失败则由规则 AI 兜底）
   */
  decideDiscard(personaKey, ctx) {
    if (!this.usable || !this.cfg.decisionMode) return Promise.resolve(null);
    const persona = PERSONAS[personaKey] || PERSONAS.chatter;
    const system = [
      `你是${persona.name}，在打四川麻将（血战到底）。`,
      '你的任务是从候选列表中选一张打出去。只回复那张牌的紧凑代号（如 3m 表示三万、7s 表示七条、1p 表示一筒），不要解释，不要加标点。',
      '注意：必须打倒你已定缺的那门（若列表里还有缺门的牌，优先打它）。',
    ].join('\n');
    const user = `我的手牌：${ctx.hand}\n已定缺：${ctx.missingSuit}\n可选：${ctx.options.join(' ')}\n打出：`;
    return this.enqueue(() => this.chat(
      [
        { role: 'system', content: system },
        { role: 'user', content: user },
      ],
      { maxTokens: 16, temperature: 0.4 },
    )).then((s) => {
      const hit = ctx.options.find((o) => s.includes(o));
      return hit ? ctx.options.indexOf(hit) : null;
    }).catch(() => null);
  }
}

/** 全局唯一的 brain 实例 */
export const brain = new LLMBrain();
