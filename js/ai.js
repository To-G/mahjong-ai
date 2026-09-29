/**
 * ai.js —— 内置规则 AI（决策内核）
 *
 * 设计原则：LLM 负责「说话」，这里负责「动脑」。
 * 算法基于：
 *   1. 向听数（离听牌还差几步）——最重要
 *   2. 有效进张（能改善牌型的牌有多少张）
 *   3. 缺门处理（血战必须先打完定缺那门）
 *   4. 危险牌回避（读对手副露与舍牌判断谁快要胡了）
 *   5. 牌效率常识（边张 1/9、孤张优先丢）
 *
 * 三档难度：easy / normal / hard
 */

import { TILE_TYPES, suitOf, rankOf, emptyCounts, countsTotal, suitCounts } from './tiles.js';
import { shanten, usefulTiles } from './shanten.js';
import { waitingTiles } from './melds.js';

/** 边张与幺九的先天劣势 */
function tileLonePenalty(t) {
  const r = rankOf(t);
  if (r === 1 || r === 9) return 3;
  if (r === 2 || r === 8) return 1;
  return 0;
}

/**
 * 构造 AI 看到的局面视图
 * @param game 引擎实例
 * @param me   座位号
 */
export function buildView(game, me) {
  const visible = emptyCounts();
  const self = game.seats[me];
  for (let i = 0; i < TILE_TYPES; i++) visible[i] += self.counts[i];
  for (const s of game.seats) {
    for (const t of s.discards) visible[t]++;
    for (const m of s.melds) visible[m.tile] += m.type === 'pung' ? 3 : 4;
  }
  const opponents = game.seats
    .map((s, i) => ({ seat: s, index: i }))
    .filter((x) => x.index !== me)
    .map((x) => ({
      index: x.index,
      discards: x.seat.discards,
      melds: x.seat.melds,
      missing: x.seat.missing,
      done: x.seat.won,
      threat: 0,
    }));
  return {
    me,
    self,
    counts: self.counts,
    meldCount: self.melds.length,
    missing: self.missing,
    visible,
    wallLeft: game.wall.length,
    opponents,
    turn: game.turnCount,
  };
}

/**
 * 对手威胁度评估：0（无威胁） ~ 3（很可能已听牌）
 * 依据：副露组数、触及正向 cynical 的舍牌时机、是否打过中张后转险牌
 */
function opponentThreat(view, opp) {
  if (opp.done) return 0;
  let th = 0;
  const m = opp.melds.length;
  if (m >= 1) th += 0.6;
  if (m >= 2) th += 0.8;
  if (m >= 3) th += 1.0;
  // 后期（牌墙快没了）所有人威胁上升
  const late = 1 - view.wallLeft / 84;
  th += Math.max(0, late) * 1.2;
  // 初期打出了大量幺九、后期开始打中张 => 大概率在做大牌/已听
  const early = opp.discards.slice(0, 6);
  const later = opp.discards.slice(6);
  const earlyYao = early.filter((t) => rankOf(t) === 1 || rankOf(t) === 9).length;
  const laterMid = later.filter((t) => rankOf(t) >= 3 && rankOf(t) <= 7).length;
  if (early.length >= 4 && earlyYao >= 3 && laterMid >= 2) th += 0.8;
  return Math.min(3, th);
}

/** 一张牌对一个对手的危险度 */
function dangerTo(view, tile, opp) {
  // 现物：对手自己打过的牌，绝对安全
  if (opp.discards.includes(tile)) return 0;
  const th = opponentThreat(view, opp);
  if (th <= 0.3) return 0;
  const r = rankOf(tile);
  // 中张比幺九危险
  let base = r >= 3 && r <= 7 ? 1 : 0.45;
  // 对手副露集中在某花色，则该花色更危险
  const mySuits = new Set(opp.melds.map((m) => suitOf(m.tile)));
  if (mySuits.has(suitOf(tile))) base *= 1.8;
  // 对手已舍出的牌周围（筋）——同一花色里距2以上的牌相对安全
  const sameSuitDiscards = opp.discards.filter((d) => suitOf(d) === suitOf(tile));
  for (const d of sameSuitDiscards) {
    if (Math.abs(rankOf(d) - r) === 0) return 0;
    if (Math.abs(rankOf(d) - r) >= 3) base *= 0.72;
  }
  return th * base;
}

/**
 * 选一张打出
 * @param view buildView 的结果
 * @param level 'easy'|'normal'|'hard'
 */
export function chooseDiscard(view, level = 'hard') {
  const { counts, meldCount, missing, visible, opponents } = view;
  const candidates = [];
  for (let t = 0; t < TILE_TYPES; t++) if (counts[t] > 0) candidates.push(t);

  // 第一阶段：只对「弃牌后的向听数」求值（便宜）
  const phase1 = [];
  for (const t of candidates) {
    counts[t]--;
    phase1.push({ tile: t, sh: shanten(counts, meldCount) });
    counts[t]++;
  }
  const minSh = Math.min(...phase1.map((r) => r.sh));

  // 第二阶段：只对最优的一批候选计算进张（贵），其余用基础分
  const opts = [];
  for (const p of phase1) {
    const t = p.tile;
    const sh = p.sh;
    let uke = 0;
    if (phase1.length <= 1 || sh === minSh || sh === minSh + 1) {
      counts[t]--;
      uke = usefulTiles(counts, meldCount, visible).count;
      counts[t]++;
    }

    // 基础：向听越小越好
    let score = -sh * 1000;
    if (level !== 'easy') score += uke * 6;
    // 缺门：血战要求胡牌时手上不能留有缺门，优先打掉
    if (missing >= 0 && suitOf(t) === missing) score += level === 'hard' ? 220 : 120;
    // 孤张 / 边张先走
    score -= tileLonePenalty(t);
    // 危险度（仅高难度开启防守）
    if (level === 'hard') {
      let dg = 0;
      for (const opp of opponents) dg += dangerTo(view, t, opp);
      score -= dg * 30;
      // 已经在听牌/接近听牌时更保守
      if (sh <= 0) score -= dg * 40;
    }
    // 保留对子/刻子的价值已经在向听数里体现，无需额外处理

    opts.push({ tile: t, sh, uke, score });
  }

  if (level === 'easy') {
    // 新手：30% 概率打出次优牌，制造“人类会犯错”的感觉
    opts.sort((a, b) => b.score - a.score);
    if (Math.random() < 0.3 && opts.length > 1) {
      return opts[1 + Math.floor(Math.random() * Math.min(2, opts.length - 1))].tile;
    }
    return opts[0].tile;
  }

  if (level === 'normal') {
    // 普通：考虑向听和进张，但不读牌
    opts.sort((a, b) => b.score - a.score);
    return opts[0].tile;
  }

  // 困难：加一点随机扰动避免完全可预测
  opts.sort((a, b) => b.score - a.score);
  const top = opts[0];
  const second = opts[1];
  if (second && Math.random() < 0.08 && top.score - second.score < 40) return second.tile;
  return top.tile;
}

/**
 * 是否应该碰这张牌
 * 碰的好处：快速成组。代价：少一次摸牌、暴露牌型。
 * 这里用「碰之后向听数是否下降」作为硬指标，再叠加番型考量。
 */
export function shouldPung(view, tile) {
  const { counts, meldCount, missing, level = 'hard' } = view;
  if (missing >= 0 && suitOf(tile) === missing) return false; // 不碰缺门
  const before = shanten(counts, meldCount);
  counts[tile] -= 2;
  const after = shanten(counts, meldCount + 1);
  counts[tile] += 2;
  if (after >= before) return false;
  // 已经两向听以上且碰了能进一大步，值得碰
  if (before - after >= 1) return true;
  return false;
}

/** 是否杠（明杠） */
export function shouldKong(view, tile) {
  const { counts, meldCount, missing } = view;
  if (missing >= 0 && suitOf(tile) === missing) return false;
  const before = shanten(counts, meldCount);
  counts[tile] -= 3;
  const after = shanten(counts, meldCount + 1);
  counts[tile] += 3;
  // 杠不会让向听变差（补摸一张），且通常增加番数，愿意杠
  return after <= before;
}

/** 暗杠 / 加杠：手上已有 4 张 */
export function shouldConcealedKong(view, tile) {
  const { counts, meldCount, missing } = view;
  if (missing >= 0 && suitOf(tile) === missing) return false;
  const before = shanten(counts, meldCount);
  counts[tile] -= 4;
  const after = shanten(counts, meldCount + 1);
  counts[tile] += 4;
  return after <= before;
}

/**
 * 是否胡这张牌
 * 简单经济学：已经有的番数太低，且自己还在很早的阶段 —— 血战里通常还是胡（因为继续打有机会做大）
 * 这里按难度给策略：hard/normal 直接胡（血战早胡早收），easy 偶尔漏胡（拟人）
 */
export function shouldRon(view, tile, fanScore) {
  const level = view.level || 'hard';
  if (level === 'easy') return Math.random() < 0.85;
  return true;
}

/** AI 定缺：选自己最弱的门 */
export function chooseMissing(counts) {
  const s = suitCounts(counts);
  // 平票时优先保留对子多的门 —— 简化：直接取数量最少
  let best = 0;
  for (let i = 1; i < 3; i++) if (s[i] < s[best]) best = i;
  return best;
}

/** 给自己/教学面板用：返回每张可选弃牌的评分明细 */
export function analyzeDiscards(view) {
  const { counts, meldCount, visible, missing } = view;
  const rows = [];
  for (let t = 0; t < TILE_TYPES; t++) {
    if (counts[t] <= 0) continue;
    counts[t]--;
    const sh = shanten(counts, meldCount);
    const uke = usefulTiles(counts, meldCount, visible).count;
    counts[t]++;
    rows.push({ tile: t, sh, uke, missing: missing === suitOf(t) });
  }
  const minSh = Math.min(...rows.map((r) => r.sh));
  rows.sort((a, b) => a.sh - b.sh || b.uke - a.uke);
  return { rows, minSh, best: rows.filter((r) => r.sh === minSh) };
}

/** 提示功能：当前听什么（若已听牌） */
export function readyTiles(counts, meldCount, visible) {
  if (shanten(counts, meldCount) !== 0) return [];
  const waits = waitingTiles(counts, meldCount, visible);
  return waits.map((t) => ({ tile: t, remain: visible ? Math.max(0, 4 - visible[t]) : 4 }));
}

export { countsTotal };
