/**
 * 无头模拟测试：不依赖浏览器，直接跑引擎逻辑
 * 运行：node tests/sim.mjs
 */

import { MahjongGame } from '../js/engine.js';
import { tileCode, countsFrom, tileName } from '../js/tiles.js';
import { canWin, isSevenPairs, evaluateWin, waitingTiles, isReady } from '../js/melds.js';
import { shanten, standardShanten, sevenPairsShanten } from '../js/shanten.js';

let pass = 0, fail = 0;
function ok(cond, msg) {
  if (cond) { pass++; }
  else { fail++; console.error('  ✗ ' + msg); }
}
function section(t) { console.log('\n── ' + t); }

/* ---------- 1. 胡牌判定 ---------- */
section('胡牌判定');

const C = (s) => countsFrom(s.split(' ').map((x) => {
  const base = { m: 0, s: 9, p: 18 }[x.slice(-1)];
  return base + parseInt(x, 10) - 1;
}));

ok(canWin(C('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 1p 1p 9s 9s')), '三顺子 + 一刻 + 一将 应胡');
ok(!canWin(C('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 3p 4s 5s')), '缺雀头的牌不应胡');
// 关键回归：有副露时手牌只需再凑 (4 - 副露数) 组
ok(canWin(C('1m 2m 3m 4m 5m 6m 7m 8m 9m 9s 9s'), 1), '已碰一组时，11 张手牌应能胡');
ok(!canWin(C('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 2p 2p'), 1), '有副露但缺雀头不应胡');
ok(canWin(C('1m 1m 1m 2m 2m 2m 3m 3m'), 2), '两组副露 + 手上两刻一将');
ok(!canWin(C('1m 1m 1m 2m 2m'), 2), '两组副露但手上只有一刻一将 → 不够，不应胡');
ok(isSevenPairs(C('1m 1m 3m 3m 5m 5m 7m 7m 9m 9m 1s 1s 3s 3s')), '标准七对');
ok(isSevenPairs(C('1m 1m 1m 1m 3m 3m 5m 5m 7m 7m 9m 9m 1s 1s')), '龙七对（4 张算两对）');
ok(!isSevenPairs(C('1m 1m 1m 3m 3m 5m 5m 7m 7m 9m 9m 1s 1s 3s')), '杂牌不是七对');
ok(canWin(C('1m 1m 1m 1m 3m 3m 5m 5m 7m 7m 9m 9m 1s 1s'), 0), '龙七对可被 canWin 识别');

/* ---------- 2. 向听数 ---------- */
section('向听数');

const k = (s) => {
  const c = C(s);
  return shanten(c, 0);
};
// 1m1m1m + 234m + 567m + 89m(待7m) + 11p => 听牌
ok(k('1m 1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 1p') === 0, '3 组 + 将 + 边搭 → 0 向听');
ok(k('1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 1p 1p 2s 2s') === -1, '已成和牌 → -1');
// 摸一张能让向听下降，才算有效进张
{
  const base = C('1m 1m 1m 2m 3m 4m 5m 6m 7m 8m 9m 1p 1p');
  const before = shanten(base, 0);
  base[6]++; // 补 7m
  ok(shanten(base, 0) < before, '摸到待牌后向听应下降');
}
ok(shanten(C('1m 1m 3m 3m 5m 5m 7m 7m 9m 9m 1s 1s 3s 3s'), 0) === -1, '七对也算胡');

// 无论怎么算，向听不能超过 8
let maxSeen = -99;
for (let i = 0; i < 300; i++) {
  const c = new Array(27).fill(0);
  let n = 0;
  while (n < 13) {
    const t = Math.floor(Math.random() * 27);
    if (c[t] < 4) { c[t]++; n++; }
  }
  const sh = shanten(c, 0);
  maxSeen = Math.max(maxSeen, sh);
}
ok(maxSeen <= 8, `随机手牌向听上限应 ≤ 8（实测 ${maxSeen}）`);

/* ---------- 3. 听牌与有效进张一致性 ---------- */
section('听牌一致性');

// 如果 shanten = 0，waitingTiles 必须非空
let consistent = true;
for (let i = 0; i < 400; i++) {
  const c = new Array(27).fill(0);
  let n = 0;
  while (n < 13) {
    const t = Math.floor(Math.random() * 27);
    if (c[t] < 4) { c[t]++; n++; }
  }
  if (shanten(c, 0) === 0) {
    const waits = waitingTiles(c, 0);
    if (waits.length === 0) { consistent = false; break; }
  }
}
ok(consistent, '所有 0 向听的牌都应能找到听的牌');

/* ---------- 4. 番型 ---------- */
section('番型');

const ev = evaluateWin({ counts: C('1m 1m 1m 2m 2m 2m 3m 3m 3m 4m 4m 4m 5m 5m'), melds: [] });
ok(ev.fans.some((f) => f.name === '对对胡'), '四刻一将应为对对胡');
ok(ev.fans.some((f) => f.name.includes('清一色')) || ev.fans.some((f) => f.name.includes('清')), '全万应带“清”');

const ev2 = evaluateWin({ counts: C('1m 1m 3m 3m 5m 5m 7m 7m 9m 9m 1s 1s 3s 3s'), melds: [] });
ok(ev2.fans.some((f) => f.name === '七对'), '七对番型');

/* ---------- 5. 全流程：4 个 AI 打完整局 ---------- */
section('整局流程压力测试');

async function runOne(seed) {
  const g = new MahjongGame({
    seed,
    thinkDelay: -130, // 去掉拟人思考延迟，测纯算法
    players: [
      { name: 'P0', type: 'ai', persona: 'prof', level: 'hard' },
      { name: 'P1', type: 'ai', persona: 'chatter', level: 'normal' },
      { name: 'P2', type: 'ai', persona: 'hothead', level: 'hard' },
      { name: 'P3', type: 'ai', persona: 'prof', level: 'easy' },
    ],
  });
  const t0 = Date.now();
  await Promise.race([
    g.start(),
    new Promise((_, rej) => setTimeout(() => rej(new Error('TIMEOUT')), 8000)),
  ]);
  return { g, ms: Date.now() - t0 };
}

const N = 40;
let okCount = 0;
let wins = 0;
let exhaust = 0;
let timeouts = 0;
let tilesMismatch = 0;
let scoreSum = 0;
let maxMs = 0;
let noWinner = 0;
let finalShSum = 0, finalShN = 0;
let totalWinners = 0;

for (let i = 0; i < N; i++) {
  try {
    const { g, ms } = await runOne(1000 + i);
    maxMs = Math.max(maxMs, ms);
    if (g.results.length > 0) wins++; else noWinner++;
    totalWinners += g.results.length;
    if (g.exhausted) exhaust++;
    scoreSum += g.seats.reduce((a, s) => a + s.score, 0);
    // 牌数守恒：手牌 + 副露 + 牌河 + 牌墙 = 108
    let total = g.wall.length;
    for (const s of g.seats) {
      let hand = 0;
      for (let t = 0; t < 27; t++) hand += s.counts[t];
      let meld = 0;
      for (const m of s.melds) meld += m.type === 'pung' ? 3 : 4;
      total += hand + meld + s.discards.length;
    }
    if (total !== 108) { tilesMismatch++; if (tilesMismatch < 4) console.error(`  ! seed ${1000 + i} 牌数=${total}`); }
    // 诊断：没胡的人最后离听牌还有多远
    for (const s of g.activeSeats()) {
      finalShSum += shanten(s.counts, s.melds.length);
      finalShN++;
    }
    okCount++;
  } catch (e) {
    if (e.message === 'TIMEOUT') timeouts++;
    else { console.error(`  ! seed ${1000 + i} 异常:`, e.message); }
  }
}

console.log(`  完成 ${okCount}/${N} 局`);
console.log(`  有胡牌: ${wins} 局 / 无人胡: ${noWinner} 局，平均胡牌人数 ${(totalWinners / N).toFixed(2)}`);
console.log(`  流局（牌摸完）: ${exhaust} 局，超时: ${timeouts}`);
console.log(`  牌数不守恒: ${tilesMismatch} 局`);
console.log(`  总分守恒检查 (应为 ${N * 400}): ${scoreSum}`);
console.log(`  未胡者终局平均向听: ${(finalShSum/Math.max(1,finalShN)).toFixed(2)}`);
console.log(`  单局最长纯耗算: ${maxMs}ms（不含拟人思考延迟）`);

ok(okCount >= N - 2, '绝大多数牌局能正常跑完');
ok(timeouts === 0, '没有死循环超时');
ok(tilesMismatch === 0, '牌数守恒 108 张');
ok(scoreSum === N * 400, '分数守恒（零和）');
ok(totalWinners / N >= 0.8, '平均每局应有 ≥0.8 人胡牌（不然不好玩）');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
