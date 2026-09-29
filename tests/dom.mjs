/**
 * DOM 冒烟测试（jsdom）：验证 UI 代码能真实跑起来、能响应点击、能打完一局。
 * 运行：
 *   set NODE_PATH=<workspace>\node_modules
 *   node tests/dom.mjs
 */

import { JSDOM } from 'jsdom';

const dom = new JSDOM('<!doctype html><html><body><div id="game"></div></body></html>', {
  url: 'http://localhost:8088/',
  pretendToBeVisual: true,
});

globalThis.window = dom.window;
globalThis.document = dom.window.document;
globalThis.localStorage = dom.window.localStorage;
globalThis.HTMLElement = dom.window.HTMLElement;
if (!globalThis.navigator) Object.defineProperty(globalThis, 'navigator', { value: dom.window.navigator, configurable: true });

const errors = [];
dom.window.addEventListener('error', (e) => errors.push('window error: ' + e.message));
process.on('unhandledRejection', (e) => errors.push('unhandledRejection: ' + (e && e.message)));

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const { boot } = await import('../js/ui.js');

let pass = 0, fail = 0;
const ok = (c, m) => { if (c) pass++; else { fail++; console.error('  ✗ ' + m); } };

console.log('── 挂载 UI');
const ui = boot('#game');
ok(!!document.querySelector('.table'), '牌桌应该被渲染出来');
ok(!!document.querySelector('#myHand'), '应该有手牌容器');
ok(document.querySelectorAll('.seat').length === 4, '应该有 4 个座位');

// 驱动：自动替“人类玩家”做选择，直到本局结束
console.log('── 自动打完一局');
let steps = 0;
let sawClaim = false;
let sawMissing = false;
const t0 = Date.now();

while (ui.game && ui.game.running && steps < 4000 && Date.now() - t0 < 90000) {
  steps++;

  const missBtn = document.querySelector('.missopts button');
  if (missBtn && ui.pendingMissing) {
    sawMissing = true;
    missBtn.click();
    await sleep(2);
    continue;
  }

  const actBtn = document.querySelector('#actionBar button[data-act]');
  if (actBtn && ui.pendingClaim) {
    sawClaim = true;
    // 优先选“过”以外的高价值动作，顺便验证非 pass 分支
    const winBtn = document.querySelector('#actionBar button[data-act="win"]');
    (winBtn || actBtn).click();
    await sleep(2);
    continue;
  }

  const tileElm = document.querySelector('#myHand .tile');
  if (tileElm && ui.pendingDiscard) {
    tileElm.click();
    await sleep(2);
    continue;
  }

  await sleep(4);
}

ok(sawMissing, '应该出现过定缺弹窗并被处理');
ok(steps < 4000, `不应该卡死（实际 ${steps} 步）`);
ok(ui.game && !ui.game.running, '本局应该正常结束');
console.log(`  步数 ${steps}，用时 ${Date.now() - t0}ms`);
console.log(`  结果：${ui.game.results.length} 次胡牌，剩余牌墙 ${ui.game.wall.length}`);
console.log(`  聊天消息：${document.querySelectorAll('#chat .bubble').length} 条`);

ok(document.querySelectorAll('#chat .bubble').length > 0, '应该有聊天/系统消息');
ok(document.querySelector('.rlist'), '结束后应该出现结算面板');

// 提示功能
console.log('── 提示功能');
ui.toggleHint();
ok(document.querySelector('#btnHint').classList.contains('active'), '提示按钮应变为激活态');
ui.toggleHint();

// 设置面板
console.log('── 设置面板');
document.querySelector('#btnSettings').click();
ok(!!document.querySelector('#inEndpoint'), '设置面板应该被渲染');
document.querySelector('#swEnable').checked = true;
document.querySelector('#inEndpoint').value = 'https://example.workers.dev/api/llm';
document.querySelector('#btnSave').click();
await sleep(20);
ok(!document.querySelector('#modalRoot').classList.contains('hidden') === false, '保存后应关闭弹窗');

// 再开一局（验证重复开局不会崩）
console.log('── 重开一局');
ui.newGame();
await sleep(50);
const missBtn2 = document.querySelector('.missopts button');
ok(!!missBtn2, '重开后应该再次要求定缺');
if (missBtn2) missBtn2.click();
await sleep(120);
ok(ui.game.running, '第二局应该在跑');

console.log('\n捕获到的运行时错误：', errors.length);
errors.slice(0, 10).forEach((e) => console.error('  ! ' + e));
ok(errors.length === 0, '不应该有运行时错误');

console.log(`\n结果：${pass} 通过 / ${fail} 失败`);
process.exit(fail > 0 ? 1 : 0);
