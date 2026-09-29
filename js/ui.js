/**
 * ui.js —— 界面渲染与交互
 *
 * 负责：牌桌布局、牌面绘制（纯 CSS，无图片依赖）、玩家操作的 Promise 化、
 *       AI 聊天气泡、设置面板、结算弹窗。
 */

import { tileName, tileCode, suitOf, rankOf, countsToTiles, countsTotal, SUIT_CN, TILE_TYPES } from './tiles.js';
import { MahjongGame } from './engine.js';
import * as AI from './ai.js';
import { shanten, usefulTiles } from './shanten.js';
import { waitingTiles } from './melds.js';
import { brain, LLMBrain, PERSONAS, loadConfig, saveConfig, defaultConfig } from './llm.js';

const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

/** 生成一张牌的内部 HTML（纯 CSS 图案） */
export function tileFace(t) {
  const suit = suitOf(t);
  const r = rankOf(t);
  if (suit === 0) {
    return `<span class="face-num">${'一二三四五六七八九'[r - 1]}</span><span class="face-wan">万</span>`;
  }
  if (suit === 1) {
    let dots = '';
    for (let i = 0; i < r; i++) dots += '<i class="bam"></i>';
    return `<span class="face-sot">${dots}</span>`;
  }
  let dots = '';
  for (let i = 0; i < r; i++) dots += '<i class="dot"></i>';
  return `<span class="face-pin${r === 1 ? ' big' : ''}">${dots}</span>`;
}

export function tileEl(t, cls = '') {
  const d = document.createElement('div');
  d.className = `tile ${cls} suit-${suitOf(t)}`;
  d.dataset.tile = String(t);
  d.title = tileName(t);
  d.innerHTML = `<span class="tile-inner">${tileFace(t)}</span>`;
  return d;
}

export function backTile(cls = '') {
  const d = document.createElement('div');
  d.className = `tile tile-back ${cls}`;
  d.innerHTML = '<span class="tile-inner"></span>';
  return d;
}

const POS_CLASS = ['me', 'right', 'top', 'left'];

export class MahjongUI {
  constructor(rootEl) {
    this.root = rootEl;
    this.game = null;
    this.pendingDiscard = null;
    this.pendingClaim = null;
    this.pendingMissing = null;
    this.hintOn = false;
    this.cfg = loadConfig();
    brain.setConfig(this.cfg);
    this.buildShell();
    this.bindShell();
  }

  /* ---------------- 骨架 ---------------- */

  buildShell() {
    this.root.innerHTML = `
      <div class="app">
        <header class="topbar">
          <div class="brand">🀄 血战到底 <span class="sub">四川麻将 · AI 对局</span></div>
          <div class="topright">
            <button class="btn ghost" id="btnHint">提示</button>
            <button class="btn ghost" id="btnSettings">AI 设置</button>
            <button class="btn primary" id="btnNew">新的一局</button>
          </div>
        </header>

        <main class="stage">
          <div class="table" id="table">
            <div class="seat seat-top" data-pos="2">
              <div class="info"></div>
              <div class="melds"></div>
              <div class="pond"></div>
            </div>
            <div class="seat seat-left" data-pos="3">
              <div class="info"></div>
              <div class="melds"></div>
              <div class="pond"></div>
            </div>
            <div class="seat seat-right" data-pos="1">
              <div class="info"></div>
              <div class="melds"></div>
              <div class="pond"></div>
            </div>
            <div class="seat seat-me" data-pos="0">
              <div class="info"></div>
              <div class="melds"></div>
              <div class="pond"></div>
              <div class="hand" id="myHand"></div>
            </div>
            <div class="centerbox">
              <div class="wallcount"><b id="wallLeft">0</b><span>张底牌</span></div>
              <div class="statusline" id="statusLine">准备开局</div>
              <div class="lastcard" id="lastCard"></div>
            </div>
          </div>

          <aside class="sidebar">
            <div class="panel chatpanel">
              <h3>牌桌闲聊</h3>
              <div class="chat" id="chat"></div>
            </div>
            <div class="panel scorepanel">
              <h3>计分</h3>
              <div class="scores" id="scores"></div>
            </div>
          </aside>
        </main>

        <div class="actionbar" id="actionBar"></div>
      </div>

      <div class="modal hidden" id="modalRoot"><div class="modal-card" id="modalCard"></div></div>
    `;
    this.el = {
      table: $('#table', this.root),
      seats: {},
      status: $('#statusLine', this.root),
      wallLeft: $('#wallLeft', this.root),
      lastCard: $('#lastCard', this.root),
      chat: $('#chat', this.root),
      scores: $('#scores', this.root),
      hand: $('#myHand', this.root),
      actionBar: $('#actionBar', this.root),
      modal: $('#modalRoot', this.root),
      modalCard: $('#modalCard', this.root),
    };
    $$('.seat', this.root).forEach((s) => {
      const pos = Number(s.dataset.pos);
      this.el.seats[pos] = {
        root: s,
        info: $('.info', s),
        melds: $('.melds', s),
        pond: $('.pond', s),
      };
    });
  }

  bindShell() {
    $('#btnNew', this.root).addEventListener('click', () => this.newGame());
    $('#btnSettings', this.root).addEventListener('click', () => this.showSettings());
    $('#btnHint', this.root).addEventListener('click', () => this.toggleHint());

    // 手牌点击（事件委托）
    this.el.hand.addEventListener('click', (e) => {
      const t = e.target.closest('.tile');
      if (!t || !this.pendingDiscard) return;
      if (this.el.hand.classList.contains('disabled')) return;
      const tile = Number(t.dataset.tile);
      const res = this.pendingDiscard;
      this.pendingDiscard = null;
      this.el.hand.classList.add('disabled');
      res(tile);
    });

    this.el.actionBar.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-act]');
      if (!b) return;
      const act = b.dataset.act;
      if (!this.pendingClaim) return;
      const resolve = this.pendingClaim;
      this.pendingClaim = null;
      this.el.actionBar.innerHTML = '';
      this.el.actionBar.classList.remove('show');
      if (act === 'pass') resolve(null);
      else resolve({ kind: act, tile: Number(b.dataset.tile) });
    });

    this.el.modal.addEventListener('click', (e) => {
      const b = e.target.closest('button[data-miss]');
      if (b && this.pendingMissing) {
        const r = this.pendingMissing;
        this.pendingMissing = null;
        this.hideModal();
        r(Number(b.dataset.miss));
      }
    });
  }

  /* ---------------- 开局 ---------------- */

  newGame() {
    if (this.game && this.game.running) {
      // 粗暴中止：清理等待中的 promise
      this.abortPending();
    }
    this.el.chat.innerHTML = '';
    this.hintOn = false;
    const game = new MahjongGame({
      hooks: this.makeHooks(),
      initialScore: 100,
      thinkDelay: 360,
    });
    this.game = game;
    this.renderAll();
    this.setStatus('开局了，先定缺');
    game.start().then(() => {
      this.setStatus('本局结束');
      this.showResult();
      this.renderAll();
    }).catch((err) => {
      console.error(err);
      this.setStatus('出错了：' + err.message);
    });
  }

  abortPending() {
    for (const k of ['pendingDiscard', 'pendingClaim', 'pendingMissing']) {
      if (this[k]) { const r = this[k]; this[k] = null; r(null); }
    }
    this.el.actionBar.innerHTML = '';
  }

  makeHooks() {
    return {
      onRender: () => this.renderAll(),
      onLog: (text) => this.pushSystemLog(text),
      onDraw: async (idx, tile, meta) => {
        if (idx === 0) {
          this.flashDraw(tile);
          this.setStatus('你摸到了 ' + tileName(tile) + '，请出牌');
        } else {
          this.setStatus(`${this.game.seats[idx].name} 摸牌`);
        }
      },
      onDiscard: async (idx, tile) => {
        this.showLastCard(idx, tile);
        this.setStatus(`${this.game.seats[idx].name} 打出 ${tileName(tile)}`);
      },
      onClaim: async (idx, kind, tile) => {
        this.setStatus(`${this.game.seats[idx].name} 碰！`);
      },
      onKong: async (idx, tile, kind) => {
        this.setStatus(`${this.game.seats[idx].name} 杠 ${tileName(tile)}`);
      },
      onMissing: async (idx, miss) => {
        this.renderAll();
      },
      onWin: async (result) => {
        this.showWinBanner(result);
      },
      onMessage: async (idx, text) => {
        this.pushChat(idx, text);
      },
      humanMissing: async (idx, suitCountsArr) => this.askMissing(suitCountsArr),
      humanDiscard: async (idx, ctx) => this.askDiscard(ctx),
      humanClaim: async (idx, opts, meta) => this.askClaim(opts, meta),
      llmSpeak: async (idx, ctx) => {
        // 没配 LLM 也照样说话（走离线台词库），只是话少一点、省得刷屏
        const p = brain.usable ? 0.45 : 0.18;
        if (Math.random() > p) return null;
        try {
          return await brain.speak(ctx.persona, ctx);
        } catch (e) { return null; }
      },
      llmDiscard: async (idx, ctx) => {
        if (!brain.usable || !brain.cfg.decisionMode) return null;
        try {
          const i = await brain.decideDiscard(ctx.persona, ctx);
          if (i == null) return null;
          return this.codeToTile(ctx.options[i]);
        } catch (e) { return null; }
      },
    };
  }

  codeToTile(code) {
    const suitKey = code.slice(-1);
    const r = parseInt(code, 10);
    const base = { m: 0, s: 9, p: 18 }[suitKey] || 0;
    return base + r - 1;
  }

  /* ---------------- 交互等待 ---------------- */

  setStatus(text) { this.el.status.textContent = text; }

  flashDraw(tile) {
    const t = tileEl(tile, 'enter');
    this.el.lastCard.innerHTML = '';
    this.el.lastCard.appendChild(t);
  }

  showLastCard(idx, tile) {
    const t = tileEl(tile, 'enter');
    this.el.lastCard.innerHTML = '';
    this.el.lastCard.appendChild(t);
  }

  askMissing(suitCountsArr) {
    const order = [0, 1, 2].sort((a, b) => suitCountsArr[a] - suitCountsArr[b]);
    this.el.modalCard.innerHTML = `
      <h2>定缺</h2>
      <p class="muted">请选择一门不要的花色。胡牌前必须把这门牌全部打出去。</p>
      <div class="missopts">
        ${order.map((s) => `<button class="btn big" data-miss="${s}">不要 ${SUIT_CN[s]}<small>手上 ${suitCountsArr[s]} 张</small></button>`).join('')}
      </div>
    `;
    this.showModal();
    return new Promise((res) => { this.pendingMissing = res; });
  }

  askDiscard(ctx) {
    this.el.hand.classList.remove('disabled');
    if (ctx.sh <= 0) this.setStatus('听牌了，选出一张打出');
    else this.setStatus(`离听牌还有 ${ctx.sh} 步，选出一张打出`);
    if (this.hintOn) this.paintHints();
    return new Promise((res) => { this.pendingDiscard = res; });
  }

  askClaim(opts, meta) {
    const labelMap = { win: '胡', kong: '杠', pung: '碰', concealedKong: '暗杠', addKong: '加杠' };
    const btns = opts.map((o) => `<button class="btn act dangerable" data-act="${o.kind}" data-tile="${o.tile}">${labelMap[o.kind] || o.kind} ${tileName(o.tile)}</button>`).join('');
    this.el.actionBar.innerHTML = btns + `<button class="btn act ghost" data-act="pass">过</button>`;
    this.el.actionBar.classList.add('show');
    this.setStatus(meta && meta.selfDraw ? '你可以：' : '要不要？');
    return new Promise((res) => { this.pendingClaim = res; });
  }

  /* ---------------- 渲染 ---------------- */

  renderAll() {
    const g = this.game;
    if (!g) return;
    for (let i = 0; i < 4; i++) this.renderSeat(i);
    this.el.wallLeft.textContent = g.wall.length;
    this.renderScores();
    if (this.hintOn) this.paintHints();
  }

  renderSeat(i) {
    const g = this.game;
    const seat = g.seats[i];
    // 座位索引直接对应方位盒子：0=下(我) 1=右 2=上 3=左
    const box = this.el.seats[i];
    if (!box) return;
    const persona = seat.persona ? PERSONAS[seat.persona] : null;

    box.info.innerHTML = `
      <div class="avatar" style="--pc:${persona ? persona.color : '#5b7c99'}">${persona ? this.avatarOf(seat.persona) : '🙂'}</div>
      <div class="meta">
        <div class="name">${seat.name}${seat.index === g.dealer ? '<span class="badge dealer">庄</span>' : ''}${seat.won ? `<span class="badge won">${seat.wonRank}胡</span>` : ''}</div>
        <div class="sub2">${persona ? persona.title : '你'} · ${seat.score} 分</div>
      </div>
      <div class="missing">${seat.missing >= 0 ? `缺${SUIT_CN[seat.missing]}` : '未定缺'}</div>
    `;

    // 副露
    box.melds.innerHTML = '';
    for (const m of seat.melds) {
      for (let k = 0; k < (m.type === 'pung' ? 3 : 4); k++) {
        const t = tileEl(m.tile, 'mini');
        if (m.type === 'concealedKong' && k === 1) box.melds.appendChild(backTile('mini'));
        else box.melds.appendChild(t);
      }
      const sp = document.createElement('div');
      sp.className = 'meldgap';
      box.melds.appendChild(sp);
    }

    // 牌河
    box.pond.innerHTML = '';
    seat.discards.forEach((t, k) => {
      const el = tileEl(t, 'mini' + (k === seat.discards.length - 1 ? ' fresh' : ''));
      box.pond.appendChild(el);
    });

    if (i === 0) {
      // 自己的手牌
      this.el.hand.innerHTML = '';
      const tiles = countsToTiles(seat.counts);
      tiles.forEach((t, k) => {
        const el = tileEl(t, 'mytile' + (k === tiles.length - 1 ? ' drawn' : ''));
        this.el.hand.appendChild(el);
      });
    }
  }

  avatarOf(key) {
    return { chatter: '🎀', hothead: '🔥', prof: '🎓' }[key] || '🎲';
  }

  renderScores() {
    if (!this.game) return;
    this.el.scores.innerHTML = this.game.seats
      .map((s) => {
        const cls = s.score >= 100 ? 'up' : s.score < 100 ? 'down' : '';
        return `<div class="srow"><span>${s.name}</span><b class="${cls}">${s.score}</b></div>`;
      })
      .join('');
  }

  pushChat(idx, text) {
    const seat = this.game.seats[idx];
    const persona = seat.persona ? PERSONAS[seat.persona] : null;
    const d = document.createElement('div');
    d.className = 'bubble';
    d.innerHTML = `<div class="who" style="--pc:${persona ? persona.color : '#5b7c99'}">${persona ? this.avatarOf(seat.persona) + ' ' : ''}${seat.name}</div><div class="txt">${escapeHtml(text)}</div>`;
    this.el.chat.appendChild(d);
    this.el.chat.scrollTop = this.el.chat.scrollHeight;
    while (this.el.chat.children.length > 60) this.el.chat.removeChild(this.el.chat.firstChild);
  }

  pushSystemLog(text) {
    const d = document.createElement('div');
    d.className = 'bubble sys';
    d.innerHTML = `<div class="txt">${escapeHtml(text)}</div>`;
    this.el.chat.appendChild(d);
    this.el.chat.scrollTop = this.el.chat.scrollHeight;
  }

  /* ---------------- 提示 ---------------- */

  toggleHint() {
    this.hintOn = !this.hintOn;
    $('#btnHint', this.root).textContent = this.hintOn ? '关闭提示' : '提示';
    $('#btnHint', this.root).classList.toggle('active', this.hintOn);
    if (this.hintOn) this.paintHints();
    else this.clearHints();
  }

  clearHints() {
    $$('.mytile', this.el.hand).forEach((el) => {
      el.classList.remove('best', 'bad');
    });
  }

  paintHints() {
    if (!this.game || !this.game.running) return;
    const seat = this.game.seats[0];
    if (!seat) return;
    const view = AI.buildView(this.game, 0);
    const res = AI.analyzeDiscards(view);
    const threshold = res.minSh;
    this.clearHints();
    $$('.mytile', this.el.hand).forEach((el) => {
      const t = Number(el.dataset.tile);
      if (!seat.counts[t]) return;
      seat.counts[t]--;
      const sh = shanten(seat.counts, seat.melds.length);
      const uke = usefulTiles(seat.counts, seat.melds.length, view.visible).count;
      seat.counts[t]++;
      if (sh > threshold) el.classList.add('bad');
      else {
        const best = res.best.find((r) => r.tile === t);
        if (best && best.uke >= Math.max(...res.best.map((b) => b.uke))) el.classList.add('best');
      }
      el.dataset.info = `打出后 ${sh === 0 ? '听牌' : sh + ' 向听'} · 进张 ${uke}`;
    });
    // 听牌的话告诉他听什么
    const waits = waitingTiles(seat.counts, seat.melds.length);
    if (waits.length) {
      this.el.status.textContent = `听牌！等：${waits.map(tileName).join('、')}`;
    }
  }

  /* ---------------- 弹窗 ---------------- */

  showModal(html) {
    if (html) this.el.modalCard.innerHTML = html;
    this.el.modal.classList.remove('hidden');
  }

  hideModal() { this.el.modal.classList.add('hidden'); }

  showWinBanner(result) {
    const g = this.game;
    const lines = result.payments
      .map((p) => `<li>${g.seats[p.from].name} → ${g.seats[p.to].name} <b class="${p.to === 0 ? 'up' : 'down'}">${p.amount}</b> 分</li>`)
      .join('');
    this.el.modalCard.innerHTML = `
      <h2>${result.selfDraw ? '自摸！' : '胡牌！'} ${g.seats[result.winner].name}</h2>
      <div class="winhand">${tileEl(result.tile).outerHTML}</div>
      <div class="fans">${result.fans.map((f) => `<span class="fan">${f.name} +${f.fan}</span>`).join('')}
        <span class="fan total">合计 ${result.total} 番</span></div>
      <ul class="paylist">${lines}</ul>
      <p class="muted">${g.activeSeats().length > 1 ? '血战到底，继续！' : '只剩你一家了…'}</p>
      <button class="btn primary wide" id="btnContinue">继续</button>
    `;
    this.showModal();
    $('#btnContinue', this.el.modalCard).addEventListener('click', () => this.hideModal());
  }

  showResult() {
    const g = this.game;
    const rows = g.seats
      .slice()
      .sort((a, b) => b.score - a.score)
      .map((s, i) => `<div class="rrow ${s.index === 0 ? 'me' : ''}"><span class="rk">#${i + 1}</span><span class="rn">${s.name}</span><b class="${s.score >= 100 ? 'up' : 'down'}">${s.score}</b></div>`)
      .join('');
    this.el.modalCard.innerHTML = `
      <h2>本局结算</h2>
      <div class="rlist">${rows}</div>
      ${g.summary && g.summary.checks.length ? `<p class="muted">查大叫/花猪：${g.summary.checks.map((c) => g.seats[c.seat].name + '·' + c.type).join('、')}</p>` : ''}
      <button class="btn primary wide" id="btnAgain">再来一局</button>
    `;
    this.showModal();
    $('#btnAgain', this.el.modalCard).addEventListener('click', () => {
      this.hideModal();
      this.newGame();
    });
  }

  /* ---------------- 设置面板 ---------------- */

  showSettings() {
    const c = this.cfg;
    this.el.modalCard.innerHTML = `
      <h2>AI 设置</h2>

      <div class="callout">
        <b>架构说明</b>：出牌由本地规则算法决定（快、准、离线）；
        大模型只负责「说话」——吐槽、点评、吹牛。这样既不烧钱也不会打错牌。
      </div>

      <label class="switch">
        <input type="checkbox" id="swEnable" ${c.enabled ? 'checked' : ''}>
        <span>启用 AI 闲聊（需要一个代理地址）</span>
      </label>

      <label class="field">
        <span>代理地址 (Worker)</span>
        <input type="text" id="inEndpoint" placeholder="https://your-worker.workers.dev/api/llm" value="${escapeAttr(c.endpoint)}">
      </label>

      <label class="field">
        <span>访问口令（可选，和 Worker 的 PROXY_TOKEN 对应）</span>
        <input type="password" id="inToken" value="${escapeAttr(c.token)}">
      </label>

      <label class="field">
        <span>模型</span>
        <input type="text" id="inModel" value="${escapeAttr(c.model)}">
      </label>

      <label class="switch">
        <input type="checkbox" id="swDecision" ${c.decisionMode ? 'checked' : ''}>
        <span>实验：让 AI 直接决定出牌（会变慢，可能打错牌）</span>
      </label>

      <div class="rowbtns">
        <button class="btn" id="btnTest">测试连接</button>
        <button class="btn primary" id="btnSave">保存</button>
      </div>
      <div class="testout" id="testOut"></div>

      <details class="help">
        <summary>不想用大模型？</summary>
        <p>不影响游戏。关掉上面的开关，AI 会用内置的离线台词库，照样有牌桌氛围。</p>
      </details>
    `;
    this.showModal();

    $('#btnSave', this.el.modalCard).addEventListener('click', async () => {
      this.cfg = {
        ...defaultConfig(),
        enabled: $('#swEnable', this.el.modalCard).checked,
        endpoint: $('#inEndpoint', this.el.modalCard).value.trim(),
        token: $('#inToken', this.el.modalCard).value.trim(),
        model: $('#inModel', this.el.modalCard).value.trim() || 'deepseek-chat',
        decisionMode: $('#swDecision', this.el.modalCard).checked,
      };
      saveConfig(this.cfg);
      brain.setConfig(this.cfg);
      brain.disabled = false;
      this.hideModal();
      this.pushSystemLog('设置已保存');
    });

    $('#btnTest', this.el.modalCard).addEventListener('click', async () => {
      const out = $('#testOut', this.el.modalCard);
      out.textContent = '测试中…';
      const tmp = new LLMBrain({
        ...defaultConfig(),
        enabled: true,
        endpoint: $('#inEndpoint', this.el.modalCard).value.trim(),
        token: $('#inToken', this.el.modalCard).value.trim(),
        model: $('#inModel', this.el.modalCard).value.trim() || 'deepseek-chat',
      });
      try {
        const r = await tmp.speak('prof', { kind: 'draw', describe: '测试连接，简单回应一句' });
        out.innerHTML = `<span class="ok">✓ 连通：${escapeHtml(r)}</span>`;
      } catch (e) {
        out.innerHTML = `<span class="err">✗ 失败：${escapeHtml(e.message)}</span>`;
      }
    });
  }
}

function escapeHtml(s) {
  return String(s).replace(/[&<>"']/g, (m) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' })[m]);
}
function escapeAttr(s) { return escapeHtml(s); }

export function boot(selector = '#game') {
  const root = document.querySelector(selector);
  const ui = new MahjongUI(root);
  ui.newGame();
  return ui;
}
