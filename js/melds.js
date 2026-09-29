/**
 * melds.js —— 胡牌判定、听牌分析、番种计算
 *
 * 四川麻将「血战到底」常见番型（做了合理简化）：
 *   平胡 1 番 / 碰碰胡 2 / 七对 2 / 龙七对 3 / 清一色 3 / 清七对 4 / 清龙七对 5 / 金钩钓 2
 *   根（某张牌 4 张全在手上）每根 +1
 *   附加：自摸 +1（加计对子胡，也称自摸加底）、杠上花 +1、抢杠 +1、海底捞 +1
 */

import { TILE_TYPES, suitOf, countsTotal, emptyCounts } from './tiles.js';

/** 判断手牌（不含副露）能否组成 need 个面子 */
function formGroups(c, need) {
  if (need === 0) {
    for (let i = 0; i < TILE_TYPES; i++) if (c[i] > 0) return false;
    return true;
  }
  let i = 0;
  while (i < TILE_TYPES && c[i] === 0) i++;
  if (i >= TILE_TYPES) return false;

  // 刻子
  if (c[i] >= 3) {
    c[i] -= 3;
    const ok = formGroups(c, need - 1);
    c[i] += 3;
    if (ok) return true;
  }
  // 顺子（同花色内，i%9 <= 6 保证不跨花色）
  const r = i % 9;
  if (r <= 6 && c[i + 1] > 0 && c[i + 2] > 0) {
    c[i]--; c[i + 1]--; c[i + 2]--;
    const ok = formGroups(c, need - 1);
    c[i]++; c[i + 1]++; c[i + 2]++;
    if (ok) return true;
  }
  return false;
}

/**
 * 标准型胡牌判定
 * @param counts 手牌（不含副露）
 * @param meldCount 副露组数，已经有 1 组的情况下手牌只需再凑 3 组
 */
export function isStandardWin(counts, meldCount = 0) {
  const need = 4 - meldCount;
  if (need < 0) return false;
  const c = counts.slice();
  for (let p = 0; p < TILE_TYPES; p++) {
    if (c[p] >= 2) {
      c[p] -= 2;
      const ok = formGroups(c, need);
      c[p] += 2;
      if (ok) return true;
    }
  }
  return false;
}

/** 七对（含龙七对：其中某一门 4 张同牌算两对） */
export function isSevenPairs(counts) {
  if (countsTotal(counts) !== 14) return false;
  let pairs = 0;
  for (let i = 0; i < TILE_TYPES; i++) {
    const x = counts[i];
    if (x === 0) continue;
    if (x === 2) pairs += 1;
    else if (x === 4) pairs += 2;
    else return false;
  }
  return pairs === 7;
}

export function hasQuadInPairs(counts) {
  for (let i = 0; i < TILE_TYPES; i++) if (counts[i] === 4) return true;
  return false;
}

/** 综合胡牌判定（七对必须门清） */
export function canWin(counts, meldCount = 0) {
  if (meldCount === 0 && isSevenPairs(counts)) return true;
  return isStandardWin(counts, meldCount);
}

/** 手上某张牌是否已“根”（4 张齐全且未形成杠） */
export function countRoots(counts) {
  let n = 0;
  for (let i = 0; i < TILE_TYPES; i++) if (counts[i] === 4) n++;
  return n;
}

/**
 * 判断是否对对胡（碰碰胡）：所有牌都能拆成刻子/杠 + 恰好一个雀头
 * 副露本身只允许是碰或杠，由调用方保证
 */
export function isAllTriplets(counts, meldCount) {
  void meldCount;
  let pair = 0;
  for (let i = 0; i < TILE_TYPES; i++) {
    const x = counts[i];
    if (x === 0) continue;
    if (x === 2) pair++;
    else if (x === 3 || x === 4) continue;
    else return false; // 出现单张或无法成组的数量
  }
  return pair === 1;
}

/** 所有牌（含副露中的牌）的花色集合 */
export function suitsUsed(counts, melds) {
  const set = new Set();
  for (let i = 0; i < TILE_TYPES; i++) if (counts[i] > 0) set.add(suitOf(i));
  for (const m of melds) set.add(suitOf(m.tile));
  return set;
}

/**
 * 番种计算
 * @param {Object} ctx
 *   counts     手牌计数（胡牌时已含胡的那张，共 3n+2 张）
 *   melds      副露数组 [{type:'pung'|'kong'|'concealedKong', tile}]
 *   selfDraw   是否自摸
 *   lastTile   是否海底（最后一张）
 *   kongDraw   是否杠上花
 *   robKong    是否抢杠
 * @returns {{fans:Array<{name:string,fan:number}>, total:number, score:number}}
 */
export function evaluateWin(ctx) {
  const { counts, melds = [], selfDraw = false, lastTile = false, kongDraw = false, robKong = false } = ctx;
  const fans = [];
  const meldCount = melds.length;
  const all = emptyCounts();
  for (let i = 0; i < TILE_TYPES; i++) all[i] += counts[i];
  for (const m of melds) {
    const n = m.type === 'pung' ? 3 : 4;
    all[m.tile] += n;
  }

  const seven = meldCount === 0 && isSevenPairs(counts);
  const dragon = seven && hasQuadInPairs(counts);
  const cleanSuit = suitsUsed(all, []).size === 1;
  const allTrip = !seven && isAllTriplets(counts, meldCount);
  const goldenHook = meldCount === 4; // 四组副露 + 一张单钓

  // 主体番：七对 或 对对胡 或 平胡
  if (seven) {
    fans.push({ name: dragon ? '龙七对' : '七对', fan: dragon ? 3 : 2 });
  } else if (allTrip) {
    fans.push({ name: '对对胡', fan: 2 });
  } else {
    fans.push({ name: '平胡', fan: 1 });
  }
  // 花色番可叠加
  if (cleanSuit) fans.push({ name: '清一色', fan: 2 });
  // 金钩钓可叠加
  if (goldenHook) fans.push({ name: '金钩钓', fan: 1 });

  // 根（同一张牌 4 张在手 / 暗杠）每根 +1
  const roots = countRoots(counts) + melds.filter((m) => m.type === 'concealedKong').length;
  if (roots > 0) fans.push({ name: `根×${roots}`, fan: roots });

  if (selfDraw) fans.push({ name: '自摸', fan: 1 });
  if (kongDraw) fans.push({ name: '杠上花', fan: 1 });
  if (robKong) fans.push({ name: '抢杠', fan: 1 });
  if (lastTile) fans.push({ name: '海底捞', fan: 1 });

  let total = 0;
  for (const f of fans) total += f.fan;
  // 计分：2^(番-1)，封顶 64 分，避免爆分
  const score = Math.min(64, Math.pow(2, Math.max(0, total - 1)));
  return { fans, total, score: Math.max(1, score) };
}

/**
 * 听牌分析：返回所有听的牌
 * @param counts 手牌（3n+1 张）
 * @param meldCount 副露组数
 * @param visible 已见牌计数（可选），用于过滤已经绝张的牌
 */
export function waitingTiles(counts, meldCount = 0, visible = null) {
  const out = [];
  for (let t = 0; t < TILE_TYPES; t++) {
    if (counts[t] >= 4) continue;
    if (visible && visible[t] >= 4) continue;
    counts[t]++;
    const ok = canWin(counts, meldCount);
    counts[t]--;
    if (ok) out.push(t);
  }
  return out;
}

/** 是否已经听牌（血战里用于「查大叫」结算） */
export function isReady(counts, meldCount = 0) {
  const total = countsTotal(counts);
  if (total % 3 !== 1) return false;
  return waitingTiles(counts, meldCount).length > 0;
}
