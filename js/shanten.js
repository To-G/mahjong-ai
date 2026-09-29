/**
 * shanten.js —— 向听数计算（AI 的决策基础）
 *
 * 向听数定义：还差几张有效牌才能听牌。
 *   -1 = 已胡，0 = 听牌，1 = 一向听 ……
 *
 * 支持两种型：
 *   标准型：4 面子 + 1 雀头
 *   七对型：7 个对子（仅限门清）
 */

import { TILE_TYPES } from './tiles.js';

const MAX = 8;

/**
 * 标准型向听数
 * 公式：shanten = 8 - 2×面子数 - 搭子数（含雀头候选）
 * 约束：面子数 + 搭子数 ≤ 5；若刚好 5 个块且没有对子，需要 +1 修正（缺雀头）
 */
/**
 * 记忆化缓存：同一次决策里同一副手牌会被反复求值
 * （试 14 张弃牌 × 27 种进张），不缓存的话单局要跑十几秒。
 */
const cacheStd = new Map();
const CACHE_MAX = 300000;

function keyOf(counts, meldCount) {
  let s = String.fromCharCode(65 + meldCount);
  for (let i = 0; i < TILE_TYPES; i++) s += String.fromCharCode(48 + counts[i]);
  return s;
}

export function standardShanten(handCounts, meldCount = 0) {
  const key = keyOf(handCounts, meldCount);
  const hit = cacheStd.get(key);
  if (hit !== undefined) return hit;
  const val = computeStandardShanten(handCounts, meldCount);
  if (cacheStd.size >= CACHE_MAX) cacheStd.clear();
  cacheStd.set(key, val);
  return val;
}

function computeStandardShanten(handCounts, meldCount) {
  const c = handCounts.slice();
  let best = MAX;

  function countBlocks(i, melds, partials, pairs) {
    const mTot = melds + meldCount;
    if (i >= TILE_TYPES || mTot + partials + pairs >= 5) {
      const m = mTot;
      let t = partials + pairs;
      if (m + t > 5) t = Math.max(0, 5 - m);
      let st = 8 - 2 * m - t;
      if (m + t === 5 && pairs === 0) st += 1;
      if (st < best) best = st;
      return;
    }
    // 跳过这张（留作孤张）
    countBlocks(i + 1, melds, partials, pairs);
    // 对子（可作雀头或搭子）
    if (c[i] >= 2) {
      c[i] -= 2;
      countBlocks(i + 1, melds, partials, pairs + 1);
      c[i] += 2;
    }
    // 两面 / 边张
    if (i % 9 <= 7 && c[i] > 0 && c[i + 1] > 0) {
      c[i]--; c[i + 1]--;
      countBlocks(i + 1, melds, partials + 1, pairs);
      c[i]++; c[i + 1]++;
    }
    // 嵌张
    if (i % 9 <= 6 && c[i] > 0 && c[i + 2] > 0) {
      c[i]--; c[i + 2]--;
      countBlocks(i + 1, melds, partials + 1, pairs);
      c[i]++; c[i + 2]++;
    }
  }

  function takeMelds(idx, melds) {
    countBlocks(0, melds, 0, 0);
    for (let i = idx; i < TILE_TYPES; i++) {
      if (c[i] >= 3) {
        c[i] -= 3;
        takeMelds(i, melds + 1);
        c[i] += 3;
      }
      if (i % 9 <= 6 && c[i] > 0 && c[i + 1] > 0 && c[i + 2] > 0) {
        c[i]--; c[i + 1]--; c[i + 2]--;
        takeMelds(i, melds + 1);
        c[i]++; c[i + 1]++; c[i + 2]++;
      }
    }
  }

  takeMelds(0, 0);
  return best;
}

/** 七对向听数 */
export function sevenPairsShanten(counts) {
  let pairs = 0;
  let kinds = 0;
  for (let i = 0; i < TILE_TYPES; i++) {
    const x = counts[i];
    if (x >= 1) kinds++;
    if (x >= 2) pairs += 1;
    if (x === 4) pairs += 1; // 4 张算两对（龙七对）
  }
  let st = 6 - pairs;
  if (kinds < 7) st += 7 - kinds;
  return st;
}

/** 综合向听数 */
export function shanten(counts, meldCount = 0) {
  const a = standardShanten(counts, meldCount);
  if (meldCount === 0) return Math.min(a, sevenPairsShanten(counts));
  return a;
}

/**
 * 有效进张：摸到哪些牌能让向听数下降
 * @param visible 已见牌计数（自己手牌 + 所有明牌），用来估算剩余张数
 * @returns {Array<{tile:number, remain:number}>}
 */
export function usefulTiles(counts, meldCount = 0, visible = null) {
  const base = shanten(counts, meldCount);
  const out = [];
  let totalRemaining = 0;
  for (let t = 0; t < TILE_TYPES; t++) {
    const own = counts[t] || 0;
    const remain = visible ? Math.max(0, 4 - visible[t]) : 4 - own;
    if (remain <= 0) continue;
    counts[t]++;
    const now = shanten(counts, meldCount);
    counts[t]--;
    if (now < base) {
      out.push({ tile: t, remain });
      totalRemaining += remain;
    }
  }
  return { tiles: out, count: totalRemaining };
}

/** 有效进张的总张数（快速版） */
export function ukeire(counts, meldCount = 0, visible = null) {
  return usefulTiles(counts, meldCount, visible).count;
}

/** 是否听牌 */
export function isTenpai(counts, meldCount = 0) {
  return shanten(counts, meldCount) === 0;
}
