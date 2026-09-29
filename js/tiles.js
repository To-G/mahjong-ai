/**
 * tiles.js —— 牌与牌山的基础定义
 *
 * 四川麻将（血战到底）用牌只有三门：万 / 条 / 筒，各 1-9 各 4 张，共 108 张。
 * 没有风牌、箭牌、花牌。不允许吃牌。
 *
 * 牌的内部编码：0-26 表示 27 种「牌型」
 *   0-8   万 1-9   (suit 0)
 *   9-17  条 1-9   (suit 1)
 *   18-26 筒 1-9   (suit 2)
 */

export const SUIT_CN = ['万', '条', '筒'];
export const SUIT_KEY = ['m', 's', 'p'];
export const NUM_CN = ['一', '二', '三', '四', '五', '六', '七', '八', '九'];
export const TILE_TYPES = 27;

/** 花色序号 0=万 1=条 2=筒 */
export const suitOf = (t) => (t / 9) | 0;
/** 点数 1-9 */
export const rankOf = (t) => (t % 9) + 1;
/** 中文名，如 "五条" */
export const tileName = (t) => NUM_CN[rankOf(t) - 1] + SUIT_CN[suitOf(t)];
/** 紧凑代号，如 "5s" */
export const tileCode = (t) => rankOf(t) + SUIT_KEY[suitOf(t)];

export const emptyCounts = () => new Array(TILE_TYPES).fill(0);

export function countsFrom(list) {
  const c = emptyCounts();
  for (const t of list) c[t]++;
  return c;
}

export function countsTotal(c) {
  let s = 0;
  for (let i = 0; i < TILE_TYPES; i++) s += c[i];
  return s;
}

export function countsToTiles(c) {
  const out = [];
  for (let t = 0; t < TILE_TYPES; t++) for (let i = 0; i < c[t]; i++) out.push(t);
  return out;
}

export const sortTiles = (list) => list.slice().sort((a, b) => a - b);

/** 把另一副 cnt 加到 c 上 */
export function mergeInto(c, cnt) {
  for (let i = 0; i < TILE_TYPES; i++) c[i] += cnt[i];
  return c;
}

/** 可复现的伪随机数发生器，方便按种子复盘同一局 */
export function makeRng(seed) {
  let s = (seed >>> 0) || 1;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

/** 洗好的一副牌墙（108 张） */
export function buildWall(rng = Math.random) {
  const wall = [];
  for (let t = 0; t < TILE_TYPES; t++) {
    for (let i = 0; i < 4; i++) wall.push(t);
  }
  for (let i = wall.length - 1; i > 0; i--) {
    const j = Math.floor(rng() * (i + 1));
    const tmp = wall[i];
    wall[i] = wall[j];
    wall[j] = tmp;
  }
  return wall;
}

/** 把 27 长度计数里属于某一花色的牌数统计出来 */
export function suitCounts(c) {
  const s = [0, 0, 0];
  for (let t = 0; t < TILE_TYPES; t++) s[suitOf(t)] += c[t];
  return s;
}

/** 手牌里数量最少的那一门（AI 定缺首选） */
export function weakestSuit(c) {
  const s = suitCounts(c);
  let best = 0;
  for (let i = 1; i < 3; i++) if (s[i] < s[best]) best = i;
  return best;
}
