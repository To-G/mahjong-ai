# 🀄 血战到底 · AI 麻将

单人对战三个 AI 的四川麻将（血战到底）。纯前端 H5，打开浏览器就能玩，可部署到 GitHub Pages + Cloudflare。

**在线试玩**：https://to-g.github.io/mahjong-ai/
**仓库地址**：https://github.com/To-G/mahjong-ai

---

## 一、架构决策：为什么大模型不负责出牌

这是这个项目最关键的取舍，先说清楚：

| 能力 | 谁来做 | 理由 |
|---|---|---|
| 决定打哪张牌 | **本地规则算法** `js/ai.js` | 算得准、20ms 出结果、离线、不花钱。LLM 算牌型很容易出错打出非法牌 |
| 吐槽 / 点评 / 吹牛 | **DeepSeek** `js/llm.js` | 这才是 LLM 真正强的地方 |
| 偶尔「手感来了」的拟人味 | 两者配合 | 算法给候选，LLM 有 45% 概率插一句嘴 |

所以：**没有 API Key、没有网络、关掉 LLM，游戏照样完整可玩**，AI 会用内置台词库跟你贫嘴，只是不会临场发挥。
这与"低体验 demo"的区别在于——AI 的牌技不会因为关掉大模型而下降，因为它本来就不靠大模型打牌。

LLM 的请求是**异步、非阻塞**的：即使 DeepSeek 回得慢，出牌也不会卡。

---

## 二、快速开始

```bash
cd mahjong
python serve.py            # 或： npx serve .
# 打开 http://localhost:8088
```

> 用了 ES Module，不能直接双击 `index.html`（file:// 协议会被 CORS 拦），必须走 http。

---

## 三、游戏规则（已实现）

**用牌**：只有万 / 条 / 筒，各 1–9 各 4 张，共 108 张。无风牌箭牌，**不允许吃牌**。

**流程**：
1. 每人 13 张，庄家先摸
2. **定缺**：各选一门不要的，胡牌前必须把这门打干净（否则算「花猪」）
3. 摸牌 → 可自摸 / 暗杠 / 加杠 → 出牌 → 他家可碰 / 杠 / 胡
4. **血战到底**：一家胡了不退出，剩下几家继续打到只剩一家
5. 结束时**查大叫**（没听牌的要赔）、**查花猪**（三门齐全的重罚）

**番型**（`js/melds.js`）：

| 番 | 番数 | 说明 |
|---|---|---|
| 平胡 | 1 | 基础 |
| 对对胡 | 2 | 全是刻子 / 杠 |
| 七对 | 2 | 门清七个对子 |
| 龙七对 | 3 | 七对中含一杠（4 张同牌） |
| 清一色 | 2 | 只有一门（可与上面叠加） |
| 金钩钓 | 1 | 四组副露 + 单钓 |
| 根 | 每根 +1 | 同一张牌 4 张在手 / 暗杠 |
| 自摸 | +1 | |
| 杠上花 / 抢杠 / 海底捞 | 各 +1 | |

计分：`2^(番数-1)`，封顶 64 分。杠另有「刮风下雨」：暗杠每家 2 分，明杠放杠者付 2 分，加杠每家 1 分。

**AI 三档难度**：`easy`（会犯错）/ `normal`（只算自己牌）/ `hard`（算向听、算进张、读你的牌、会防守）。

---

## 四、部署

### 1. GitHub Pages（前端）— ✅ 已部署

- 仓库：https://github.com/To-G/mahjong-ai
- 在线地址：https://to-g.github.io/mahjong-ai/
- 源码分支 `main`、根目录 `/`，Pages 已开启（`build_type: legacy`），构建状态 `built`
- 关键资源已验证可访问：`/`、`/js/ui.js`、`/js/engine.js`、`/css/style.css` 全部 HTTP 200

若要在别的账号重新部署：

```bash
cd mahjong
git init && git add . && git commit -m "feat: 四川麻将血战到底 AI 版"
git branch -M main
git remote add origin https://github.com/<你的账号>/<仓库名>.git
git push -u origin main
```

然后：仓库 **Settings → Pages → Source 选 `main` / 根目录 `/`** → Save。

> ⚠️ 提交前务必确认 `git status` 里**没有** `worker/.dev.vars`，那里面是 API Key。
> 已加入 `.gitignore`，可以用 `git check-ignore -v worker/.dev.vars` 验证。

> 🌐 **中国大陆网络注意**：本机直连 `github.com`（TCP 443）会超时，`api.github.com` 正常。
> 所有 GitHub 命令都需要挂代理：`export HTTPS_PROXY=http://127.0.0.1:7890`，
> 且 git 需配 `git config http.proxy http://127.0.0.1:7890`（本仓库已配置）。
> `gh auth login --web` 不带代理会卡在 `POST https://github.com/login/device/code` 失败。

### 2. Cloudflare Worker（AI 代理）— ⏳ 待部署

> 这一步是**可选的增强**：不做也能玩，只是 AI 无法临场发挥，只用内置台词库。
> 本机没有 Cloudflare 凭据（无 `.wrangler` 配置、无 `CLOUDFLARE_*` 环境变量），需要先授权。

**为什么必须有它**：DeepSeek 的 Key 一旦写进前端代码并推到 GitHub，会被自动扫描机器人在几分钟内盗刷。
Worker 的作用是把 Key 藏在服务端，前端只见一个 Worker 地址。

```bash
cd worker
npm i -D wrangler                       # 或用 npx wrangler

wrangler login                          # 第一次会打开浏览器授权（点一次 Allow）

wrangler secret put DEEPSEEK_API_KEY    # 粘贴你的 key（加密存储，看不到也拉不回来）
# 可选：wrangler secret put PROXY_TOKEN  # 给代理加一道口令

wrangler deploy                         # 部署完会给出 https://mahjong-ai-proxy.<子域>.workers.dev
```

若不想走浏览器授权，也可以用 API Token（Dash → My Profile → API Tokens → 
模板选 **Edit Cloudflare Workers**），然后：

```bash
export CLOUDFLARE_API_TOKEN=<你的 token>
wrangler deploy
```

验证一下：

```bash
curl https://mahjong-ai-proxy.<子域>.workers.dev/api/health
# {"ok":true,"hasKey":true,"lockEnabled":false,"model":"deepseek-chat"}
```

> 免费额度：每天 10 万次请求，一个人打牌绰绰有余。
> 这个 Worker 每秒最多放行 3 次请求（同 IP），防止账单被意外打爆。

### 3. 把两边连起来

打开游戏 → 右上「AI 设置」→ 填 `https://mahjong-ai-proxy.<子域>.workers.dev/api/llm` → 勾选启用 → 点「测试连接」。
看到绿色的 ✓ 就通了。（如果 Worker 设了 `PROXY_TOKEN`，这里同一个口令也要填上。）

配置存在浏览器 `localStorage`，每个访问者填自己的即可。

---

## 五、目录结构

```
mahjong/
├── index.html            入口
├── css/style.css         全部样式，牌面是纯 CSS 画的，零图片依赖
├── js/
│   ├── tiles.js          牌的编码、洗牌、番单数统计
│   ├── melds.js          胡牌判定、听牌列表、番型计算
│   ├── shanten.js        向听数（AI 的决策基础，带记忆化缓存）
│   ├── ai.js             ★ 决策内核：向听 + 进张 + 缺门 + 防守
│   ├── llm.js            ★ 人格层：三种性格 + 离线台词库 + Worker 客户端
│   ├── engine.js         牌局状态机（发牌/定缺/摸打/碰杠/结算）
│   └── ui.js             渲染与交互
├── worker/
│   ├── src/index.js      Cloudflare Worker：DeepSeek 代理 + 限流 + 口令
│   ├── wrangler.toml
│   ├── .dev.vars         本地调试用的 key（被 gitignore）
│   └── .dev.vars.example
├── tests/
│   ├── sim.mjs           引擎逻辑回归（40 局压力测试）
│   └── dom.mjs           UI 冒烟测试（jsdom，自动打完一局）
└── serve.py              本地预览服务器
```

三个 AI 的性格写在 `js/llm.js` 的 `PERSONAS`：**圆圆**（话痨妹妹）、**阿伟**（暴躁老哥）、**老周**（冷静算牌男）。
改性格只要改那里的 `style` 一行字，出牌逻辑完全不受影响。

---

## 六、测试

```bash
node tests/sim.mjs   # 引擎：胡牌判定、向听数、番型、40 局全流程（牌数/分数守恒）
node tests/dom.mjs   # UI：jsdom 里自动点完一局（需要 npm i jsdom）
```

当前状态：

```
sim: 24 通过 / 0 失败   —— 平均 1.38 人胡牌，未胡者终局平均 0.27 向听（AI 打得挺紧）
dom: 14 通过 / 0 失败   —— 0 运行时错误
```

---

## 七、安全提醒

- 你的 API Key 曾经明文出现在聊天记录里，**建议去 DeepSeek 后台轮换一次**。
- `worker/.dev.vars`、`node_modules` 已在 `.gitignore` 里，提交前用 `git status` 再确认一遍。
- 线上 Key 用 `wrangler secret put` 写入，它不会出现在任何文件中。
