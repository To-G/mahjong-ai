/**
 * engine.js —— 四川麻将「血战到底」游戏引擎
 *
 * 纯逻辑，不碰 DOM。UI 通过 hooks 接入（异步等待玩家操作 + 接收事件做动画）。
 *
 * 流程：
 *   发牌 → 定缺 → 庄家开局 → [摸牌 → 自检(自摸/暗杠/加杠) → 出牌 → 他家响应(碰/杠/胡)] ×N
 *   → 一家胡了不停，血战继续，直到只剩一家没胡或牌摸完 → 查大叫 / 查花猪 → 结算
 */

import {
  buildWall, makeRng, emptyCounts, suitCounts, suitOf, rankOf,
  tileName, tileCode, countsToTiles, countsTotal, TILE_TYPES,
} from './tiles.js';
import { canWin, evaluateWin, waitingTiles, isReady, isSevenPairs } from './melds.js';
import { shanten } from './shanten.js';
import * as AI from './ai.js';

const NOOP = async () => {};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class MahjongGame {
  constructor(opts = {}) {
    const {
      players = [
        { name: '你', type: 'human' },
        { name: '圆圆', type: 'ai', persona: 'chatter', level: 'normal' },
        { name: '阿伟', type: 'ai', persona: 'hothead', level: 'hard' },
        { name: '老周', type: 'ai', persona: 'prof', level: 'hard' },
      ],
      seed = Date.now(),
      hooks = {},
      initialScore = 100,
      thinkDelay = 620,
    } = opts;

    this.seed = seed >>> 0;
    this.rng = makeRng(this.seed);
    this.hooks = Object.assign(
      {
        onDraw: NOOP,
        onDiscard: NOOP,
        onClaim: NOOP,
        onKong: NOOP,
        onMissing: NOOP,
        onWin: NOOP,
        onMessage: NOOP,
        onLog: NOOP,
        onRender: NOOP,
        onGameOver: NOOP,
        humanMissing: async () => 0,
        humanDiscard: async () => 0,
        humanClaim: async () => null,
        llmSpeak: async () => null,
        llmDiscard: async () => null,
      },
      hooks,
    );
    this.initialScore = initialScore;
    this.thinkDelay = thinkDelay;
    this.playerSpecs = players;

    this.seats = players.map((p, i) => ({
      index: i,
      name: p.name,
      type: p.type,
      persona: p.persona || null,
      level: p.level || 'hard',
      counts: emptyCounts(),
      melds: [],
      discards: [],
      missing: -1,
      score: initialScore,
      won: false,
      wonRank: 0,
      hideCount: false,
    }));

    this.wall = [];
    this.dealer = 0;
    this.turnCount = 0;
    this.winOrder = [];
    this.results = [];
    this.exhausted = false;
    this.running = false;
    this.lastDiscard = null;
    this.lastDiscardSeat = -1;
    this.pendingKongDraw = false;
    this.log = [];
  }

  /* ---------------- 工具方法 ---------------- */

  next(i) { return (i + 1) % 4; }

  activeSeats() { return this.seats.filter((s) => !s.won); }

  /** 所有人可见的牌计数（用于 AI 估算剩余张数） */
  visibleCounts(forSeat = -1) {
    const v = emptyCounts();
    for (let i = 0; i < TILE_TYPES; i++) {
      if (forSeat >= 0) v[i] += this.seats[forSeat].counts[i];
    }
    for (const s of this.seats) {
      for (const t of s.discards) v[t]++;
      for (const m of s.melds) v[m.tile] += m.type === 'pung' ? 3 : 4;
    }
    return v;
  }

  /** 某一门是否还在手上（未打完缺门） */
  hasSuit(seat, suit) {
    if (seat.counts.some((n, t) => n > 0 && suitOf(t) === suit)) return true;
    return seat.melds.some((m) => suitOf(m.tile) === suit);
  }

  /** 胡牌合法性：缺门必须已经打干净 */
  canDeclareWin(seat) {
    if (seat.missing < 0) return true;
    return !this.hasSuit(seat, seat.missing);
  }

  handText(seat) {
    const tiles = countsToTiles(seat.counts).sort((a, b) => a - b);
    if (seat.type === 'human') return tiles.map(tileName).join(' ');
    return tiles.map(tileCode).join(' ');
  }

  /** AI 视图 */
  view(idx) {
    const v = AI.buildView(this, idx);
    v.level = this.seats[idx].level;
    return v;
  }

  async say(idx, text) {
    if (!text) return;
    this.log.push({ seat: idx, text });
    await this.hooks.onMessage(idx, text);
  }

  addLog(text) {
    this.log.push({ seat: -1, text });
    this.hooks.onLog(text);
  }

  render() { this.hooks.onRender(); }

  /* ---------------- 开局 ---------------- */

  async start() {
    this.running = true;
    this.wall = buildWall(this.rng);

    // 发牌：每人 13 张
    for (let round = 0; round < 13; round++) {
      for (let i = 0; i < 4; i++) {
        const t = this.wall.pop();
        this.seats[(this.dealer + i) % 4].counts[t]++;
      }
    }
    this.addLog('开局发牌，每人 13 张');
    this.render();

    await this.missingPhase();
    await this.mainLoop();
    await this.finish();
    this.running = false;
  }

  async missingPhase() {
    for (let i = 0; i < 4; i++) {
      const idx = (this.dealer + i) % 4;
      const seat = this.seats[idx];
      let miss;
      if (seat.type === 'human') {
        miss = await this.hooks.humanMissing(idx, suitCounts(seat.counts));
      } else {
        await sleep(220);
        miss = AI.chooseMissing(seat.counts);
      }
      seat.missing = miss;
      await this.hooks.onMissing(idx, miss);
      this.render();
    }
    this.addLog('定缺完成：' + this.seats.map((s) => `${s.name}[${['万', '条', '筒'][s.missing]}]`).join(' '));
  }

  /* ---------------- 主循环 ---------------- */

  async mainLoop() {
    let cur = this.dealer;
    let mode = 'draw'; // draw=摸牌后打出, claim=碰牌后直接打出

    while (true) {
      if (this.activeSeats().length <= 1) break;
      if (this.wall.length === 0 && mode === 'draw') { this.exhausted = true; break; }

      const seat = this.seats[cur];
      if (seat.won) { cur = this.next(cur); mode = 'draw'; continue; }

      let drawnTile = null;
      const isLastTile = mode === 'draw' && this.wall.length <= 1;

      if (mode === 'draw') {
        drawnTile = this.wall.pop();
        seat.counts[drawnTile]++;
        this.turnCount++;
        await this.hooks.onDraw(cur, drawnTile, { last: isLastTile });
        this.render();

        const selfOpts = this.selfOptions(cur, drawnTile);
        if (selfOpts.length) {
          const choice = await this.askSelfAction(cur, drawnTile, selfOpts, isLastTile);
          if (choice && choice.type === 'win') {
            await this.declareWin({
              winner: cur,
              tile: drawnTile,
              selfDraw: true,
              lastTile: isLastTile,
              kongDraw: this.pendingKongDraw,
            });
            this.pendingKongDraw = false;
            if (this.activeSeats().length <= 1) break;
            cur = this.next(cur);
            mode = 'draw';
            continue;
          }
          if (choice && (choice.type === 'concealedKong' || choice.type === 'addKong')) {
            const isConcealed = choice.type === 'concealedKong';
            seat.counts[drawnTile] -= isConcealed ? 4 : 1;
            if (!isConcealed) {
              const m = seat.melds.find((x) => x.type === 'pung' && x.tile === drawnTile);
              m.type = 'addedKong';
            } else {
              seat.melds.push({ type: 'concealedKong', tile: drawnTile, from: cur });
            }
            await this.hooks.onKong(cur, drawnTile, choice.type);
            await this.settleKong(cur, drawnTile, choice.type);
            this.pendingKongDraw = true;
            this.render();
            await this.maybeSpeak(cur, 'kong', { tile: drawnTile });
            mode = 'draw'; // 杠完后补摸（原地继续）
            continue;
          }
        }
      } else {
        // 碰牌后进账，无需摸牌
        mode = 'draw'; // 恢复默认，本轮直接打出
      }

      const discardTile = await this.chooseDiscardFrom(cur);
      seat.counts[discardTile]--;
      seat.discards.push(discardTile);
      this.lastDiscard = discardTile;
      this.lastDiscardSeat = cur;
      await this.hooks.onDiscard(cur, discardTile);
      this.render();
      await this.maybeSpeak(cur, 'discard', { tile: discardTile });

      const claim = await this.resolveClaims(cur, discardTile, isLastTile);
      if (!claim) {
        cur = this.next(cur);
        continue;
      }
      if (claim.kind === 'win') {
        await this.declareWin({
          winner: claim.seat,
          tile: discardTile,
          selfDraw: false,
          loser: cur,
          lastTile: isLastTile || this.wall.length === 0,
          robKong: claim.robKong || false,
        });
        if (this.activeSeats().length <= 1) break;
        // 点炮后由放炮者的下家继续（简化：由胡牌者的下家开始）
        cur = this.next(claim.seat);
        mode = 'draw';
        continue;
      }
      // 杠 / 碰 -> 由该家处理
      cur = claim.seat;
      if (claim.kind === 'kong') {
        this.graphClaimMove(claim, cur, discardTile);
        await this.hooks.onKong(cur, discardTile, 'kong');
        await this.settleKong(cur, discardTile, 'kong');
        await this.maybeSpeak(cur, 'kong', { tile: discardTile });
        this.render();
        mode = 'draw';
        this.pendingKongDraw = true;
        continue;
      }
      this.graphClaimMove(claim, cur, discardTile);
      await this.hooks.onClaim(cur, 'pung', discardTile);
      await this.maybeSpeak(cur, 'pung', { tile: discardTile });
      this.render();
      mode = 'claim';
    }
  }

  graphClaimMove(claim, seatIdx, tile) {
    const victim = this.seats[this.lastDiscardSeat];
    const i = victim.discards.lastIndexOf(tile);
    if (i >= 0) victim.discards.splice(i, 1);
    const me = this.seats[seatIdx];
    const n = claim.kind === 'kong' ? 3 : 2;
    me.counts[tile] -= n;
    me.melds.push({ type: claim.kind === 'kong' ? 'kong' : 'pung', tile, from: this.lastDiscardSeat });
  }

  /* ---------------- 决策：出牌 ---------------- */

  async chooseDiscardFrom(idx) {
    const seat = this.seats[idx];
    if (seat.type === 'human') {
      const ctx = { sh: shanten(seat.counts, seat.melds.length) };
      const tile = await this.hooks.humanDiscard(idx, ctx);
      if (typeof tile === 'number' && seat.counts[tile] > 0) return tile;
      // 兜底
      for (let t = 0; t < TILE_TYPES; t++) if (seat.counts[t] > 0) return t;
    }
    await sleep(this.thinkDelay + Math.random() * 260);

    // LLM 决策模式（实验）：命中则采用，否则规则 AI 兜底
    if (this.hooks.llmDiscard) {
      const v = this.view(idx);
      const options = [];
      for (let t = 0; t < TILE_TYPES; t++) if (seat.counts[t] > 0) options.push(tileCode(t));
      const hand = countsToTiles(seat.counts).map(tileCode).join(' ');
      const chosen = await this.hooks.llmDiscard(idx, {
        persona: seat.persona,
        hand,
        options,
        missingSuit: ['万', '条', '筒'][seat.missing] ?? '无',
      });
      if (chosen != null && seat.counts[chosen] > 0) {
        this.addLog(`${seat.name}（LLM）打出 ${tileName(chosen)}`);
        const best = AI.chooseDiscard(v, seat.level);
        if (chosen !== best) this.addLog(`  └ 规则 AI 建议打 ${tileName(best)}，LLM 有自己的想法`);
        return chosen;
      }
    }
    return AI.chooseDiscard(this.view(idx), seat.level);
  }

  async maybeSpeak(idx, kind, ctx = {}) {
    const seat = this.seats[idx];
    if (!seat.persona) return;
    const describe = ctx.describe || (ctx.tile != null
      ? `你刚刚${kind === 'discard' ? '打出' : kind === 'pung' ? '碰了' : kind === 'kong' ? '杠了' : '摸到'}${tileName(ctx.tile)}`
      : '');
    const text = await this.hooks.llmSpeak(idx, {
      persona: seat.persona,
      kind,
      describe,
      tileName: ctx.tile != null ? tileName(ctx.tile) : '',
    });
    if (text) await this.say(idx, text);
  }

  /* ---------------- 决策：自摸 / 杠 ---------------- */

  selfOptions(idx, tile) {
    const seat = this.seats[idx];
    const opts = [];
    // 自摸
    seat.counts[tile]--;
    const winOK = canWin(seat.counts, seat.melds.length) && this.canDeclareWin(seat);
    seat.counts[tile]++;
    if (winOK) opts.push('win');
    // 暗杠：手上 4 张
    if (seat.counts[tile] === 4 && suitOf(tile) !== seat.missing && this.wall.length > 0) {
      opts.push('concealedKong');
    }
    // 加杠：已有该牌的碰
    if (seat.melds.some((m) => m.type === 'pung' && m.tile === tile) && this.wall.length > 0) {
      opts.push('addKong');
    }
    return opts;
  }

  async askSelfAction(idx, tile, opts, isLastTile) {
    const seat = this.seats[idx];
    if (seat.type === 'ai') {
      const v = this.view(idx);
      if (opts.includes('win')) {
        if (AI.shouldRon(v, tile)) return { type: 'win' };
      }
      if (opts.includes('concealedKong') && AI.shouldConcealedKong(v, tile)) return { type: 'concealedKong' };
      if (opts.includes('addKong') && AI.shouldConcealedKong(v, tile)) return { type: 'addKong' };
      return null;
    }
    const choice = await this.hooks.humanClaim(idx, opts.map((t) => ({ kind: t, tile })), { selfDraw: true });
    return choice || null;
  }

  /* ---------------- 决策：他家出牌后的响应 ---------------- */

  claimOptions(idx, tile, allowWin = true) {
    const seat = this.seats[idx];
    const opts = [];
    if (allowWin) {
      seat.counts[tile]++;
      const ok = canWin(seat.counts, seat.melds.length) && this.canDeclareWin(seat);
      seat.counts[tile]--;
      if (ok) opts.push({ kind: 'win', tile });
    }
    const mySuit = suitOf(tile);
    if (seat.missing >= 0 && mySuit === seat.missing) return opts; // 缺门不可碰杠
    if (seat.counts[tile] >= 3) opts.push({ kind: 'kong', tile });
    if (seat.counts[tile] >= 2) opts.push({ kind: 'pung', tile });
    return opts;
  }

  async resolveClaims(fromIdx, tile, isLastTile) {
    const seq = [1, 2, 3].map((d) => (fromIdx + d) % 4).filter((i) => !this.seats[i].won);

    let kongCand = null;
    let pungCand = null;

    // 先收集人类/AI 的选择：先问 AI（瞬间），再问人类（等点击）
    const decisions = [];
    for (const idx of seq) {
      const opts = this.claimOptions(idx, tile);
      if (!opts.length) { decisions.push({ idx, choice: null, opts }); continue; }
      const seat = this.seats[idx];
      if (seat.type === 'ai') {
        const v = this.view(idx);
        let choice = null;
        if (opts.some((o) => o.kind === 'win') && AI.shouldRon(v, tile)) choice = { kind: 'win', tile };
        else if (opts.some((o) => o.kind === 'kong') && AI.shouldKong(v, tile)) choice = { kind: 'kong', tile };
        else if (opts.some((o) => o.kind === 'pung') && AI.shouldPung(v, tile)) choice = { kind: 'pung', tile };
        decisions.push({ idx, choice, opts });
      } else {
        await sleep(120);
        const choice = await this.hooks.humanClaim(idx, opts, { selfDraw: false, from: fromIdx });
        decisions.push({ idx, choice, opts });
      }
    }

    let bestHup = null;
    for (const d of decisions) {
      if (d.choice && d.choice.kind === 'win') { bestHup = d.idx; break; }
    }
    if (bestHup != null) return { seat: bestHup, kind: 'win', tile };

    for (const d of decisions) if (d.choice?.kind === 'kong') { kongCand = d.idx; break; }
    if (kongCand != null) return { seat: kongCand, kind: 'kong', tile };

    for (const d of decisions) if (d.choice?.kind === 'pung') { pungCand = d.idx; break; }
    if (pungCand != null) return { seat: pungCand, kind: 'pung', tile };

    return null;
  }

  /* ---------------- 结算 ---------------- */

  async settleKong(idx, tile, kind) {
    const seat = this.seats[idx];
    const rule = { concealedKong: { each: 2 }, kong: { single: 2 }, addedKong: { each: 1 } }[kind] || { each: 1 };
    const payments = [];
    for (const s of this.seats) {
      if (s.index === idx || s.won) continue;
      const amount = rule.each || rule.single;
      payments.push({ from: rule.single ? this.lastDiscardSeat : s.index, to: idx, amount, tile, kind });
    }
    // 明杠只有放杠者付
    if (rule.single) {
      payments.length = 0;
      const from = this.lastDiscardSeat;
      if (from !== idx && !this.seats[from].won) {
        payments.push({ from, to: idx, amount: rule.single, tile, kind });
      }
    }
    for (const p of payments) {
      this.seats[p.from].score -= p.amount;
      this.seats[p.to].score += p.amount;
      if (this.seats[p.from].type === 'human' || this.seats[p.to].type === 'human') {
        this.addLog(`${this.seats[p.from].name} → ${this.seats[p.to].name}：杠 ${p.amount} 分`);
      }
    }
    this.render();
  }

  /** 计算一名玩家的振听 的最大可能番 */
  maxPotentialScore(seat) {
    const waits = waitingTiles(seat.counts, seat.melds.length);
    let bestScore = 0;
    let bestFan = '';
    for (const t of waits) {
      seat.counts[t]++;
      try {
        const ev = evaluateWin({ counts: seat.counts, melds: seat.melds, selfDraw: false });
        if (ev.score > bestScore) { bestScore = ev.score; bestFan = ev.fans.map((f) => f.name).join('、'); }
      } catch (e) { /* ignore */ }
      seat.counts[t]--;
    }
    return { score: bestScore, fan: bestFan, waits };
  }

  async declareWin(info) {
    const { winner, tile, selfDraw, loser = -1, lastTile = false, kongDraw = false, robKong = false } = info;
    const seat = this.seats[winner];
    if (seat.won) return;

    seat.counts[tile]++;
    const ev = evaluateWin({ counts: seat.counts, melds: seat.melds, selfDraw, lastTile, kongDraw, robKong });
    seat.won = true;
    seat.wonRank = this.winOrder.length + 1;
    this.winOrder.push(winner);

    const payments = [];
    if (selfDraw) {
      for (const s of this.seats) {
        if (s.index === winner || s.won) continue;
        payments.push({ from: s.index, to: winner, amount: ev.score });
      }
    } else {
      let from = loser;
      if (from < 0 || from === winner) return;
      // 把被胡的那张牌从牌河里拿走，交给赢家，保证牌数守恒
      const pond = this.seats[from].discards;
      const i = pond.lastIndexOf(tile);
      if (i >= 0) pond.splice(i, 1);
      payments.push({ from, to: winner, amount: ev.score });
    }
    for (const p of payments) {
      this.seats[p.from].score -= p.amount;
      this.seats[p.to].score += p.amount;
    }

    const result = {
      winner,
      tile,
      selfDraw,
      from: loser,
      fans: ev.fans,
      total: ev.total,
      score: ev.score,
      payments,
      handText: this.handText(seat),
    };
    this.results.push(result);
    await this.hooks.onWin(result);
    await this.maybeSpeak(winner, 'win', { tile, describe: `你${selfDraw ? '自摸' : '胡了别人打出的'}${tileName(tile)}，番型：${ev.fans.map((f) => f.name).join('、')}` });
    for (const s of this.seats) {
      if (s.index === winner || !s.persona || s.type === 'human') continue;
      if (payments.some((p) => p.from === s.index)) {
        await this.maybeSpeak(s.index, 'lose', { tile, describe: `${this.seats[winner].name}胡了${tileName(tile)}` });
      }
    }
    this.render();
  }

  /* ---------------- 收尾：查大叫 / 查花猪 ---------------- */

  async finish() {
    const active = this.activeSeats();
    if (active.length === 0 || active.length >= 4) return;

    const checks = [];
    const tenpaiMap = {};
    for (const s of active) {
      const ready = isReady(s.counts, s.melds.length);
      tenpaiMap[s.index] = ready;
      if (ready) {
        const pot = this.maxPotentialScore(s);
        tenpaiMap[`${s.index}_max`] = pot.score;
        tenpaiMap[`${s.index}_waits`] = pot.waits;
      }
      // 花猪：手上仍有三门
      const suits = new Set();
      for (let t = 0; t < TILE_TYPES; t++) {
        if (s.counts[t] > 0) suits.add(suitOf(t));
        for (const m of s.melds) suits.add(suitOf(m.tile));
      }
      if (suits.size === 3) checks.push({ seat: s.index, type: '花猪' });
      else if (!ready) checks.push({ seat: s.index, type: '大叫' });
    }

    // 赔付规则（简化）：未听牌/花猪者向每位听牌者赔付其最大可能番；花猪额外翻倍
    const payers = active.filter((s) => !tenpaiMap[s.index]);
    const receivers = active.filter((s) => tenpaiMap[s.index]);
    for (const p of payers) {
      const isPig = checks.some((c) => c.seat === p.index && c.type === '花猪');
      for (const r of receivers) {
        const amount = Math.max(1, tenpaiMap[`${r.index}_max`] || 1) * (isPig ? 2 : 1);
        this.seats[p.index].score -= amount;
        this.seats[r.index].score += amount;
        this.addLog(`结算：${p.name} ${isPig ? '花猪' : '未听牌'} → ${r.name} ${amount} 分`);
      }
    }
    this.summary = {
      checks,
      tenpai: Object.keys(tenpaiMap).filter((k) => !k.includes('_') && tenpaiMap[k]).map(Number),
    };
    this.render();
  }

  /** 给 UI 的当前状态快照 */
  snapshot() {
    return {
      wall: this.wall.length,
      dealer: this.dealer,
      turn: this.turnCount,
      seats: this.seats.map((s) => ({
        index: s.index,
        name: s.name,
        type: s.type,
        persona: s.persona,
        missing: s.missing,
        meldCount: s.melds.length,
        melds: s.melds,
        discardCount: s.discards.length,
        score: s.score,
        won: s.won,
        handCount: countsTotal(s.counts),
      })),
      lastDiscard: this.lastDiscard,
      lastDiscardSeat: this.lastDiscardSeat,
      exhausted: this.exhausted,
      log: this.log.slice(-40),
    };
  }
}

export { tileName, tileCode, shanten, AI };
