/* Kurumi FX 引擎冒烟测试：node test.js */
'use strict';
const { Engine, COUNTRIES, LEV_OPTIONS } = require('./engine.js');

let pass = 0, fail = 0;
function assert(name, cond, extra) {
  if (cond) { pass++; console.log('  ✅ ' + name); }
  else { fail++; console.log('  ❌ ' + name + (extra ? ' | ' + JSON.stringify(extra) : '')); }
}

/* T1 正常：市价买入成交，现金减少、持仓增加 */
{
  const e = new Engine();
  const code = 'TVT';
  const qty = 10;
  const r = e.placeOrder('buy', code, qty, 0, true);
  assert('T1 市价单成交', r.ok && r.filled > 0, r);
  assert('T1 现金减少', e.state.cash < 300000, e.state.cash);
  assert('T1 持仓>0', e.state.positions[code].qty > 0, e.state.positions[code]);
  assert('T1 净值不变（零和：现金+市值=初始）', Math.abs(e.netWorth() - 300000) < 1, e.netWorth());
}

/* T2 边界：杠杆 2 倍购买力 = 现金×2 */
{
  const e = new Engine();
  e.state.lev = 2;
  assert('T2 2x购买力', Math.abs(e.buyingPower() - 600000) < 0.01, e.buyingPower());
}

/* T3 边界：无穷杠杆购买力 Infinity */
{
  const e = new Engine();
  e.state.lev = 'inf';
  assert('T3 inf购买力', e.buyingPower() === Infinity);
}

/* T4 异常：数量 0 / 负数 拒单 */
{
  const e = new Engine();
  const r0 = e.placeOrder('buy', 'TVT', 0, 0, true);
  const rn = e.placeOrder('buy', 'TVT', -5, 0, true);
  assert('T4 数量0拒单', r0.ok === false, r0);
  assert('T4 负数拒单', rn.ok === false, rn);
}

/* T5 异常：无持仓卖单拒单 */
{
  const e = new Engine();
  const r = e.placeOrder('sell', 'TVT', 1, 0, true);
  assert('T5 空仓卖出拒单', !r.ok && r.msg.includes('持仓不足'), r);
}

/* T6 限价挂单 + 撤单 */
{
  const e = new Engine();
  const mk = e.state.mk['TVT'];
  const lowPrice = mk.mid * 0.5; // 远低于现价，无法立即成交 -> 挂单
  const r = e.placeOrder('buy', 'TVT', 1, lowPrice, false);
  assert('T6 限价挂单', r.ok && e.state.orders.length === 1, { r, orders: e.state.orders.length });
  const oid = e.state.orders[0].id;
  e.cancelOrder(oid);
  assert('T6 撤单生效', e.state.orders.length === 0);
}

/* T7 剧本：一键同意 -> 闪崩 -> 强平 -> 负债保留 */
{
  const e = new Engine();
  const r = e.acceptAdvice();
  assert('T7 一键同意成交', r.ok && e.state.holding === true && e.state.crash !== null, r);
  const debtBefore = e.tradeDebt();
  for (let i = 0; i < 30 && !e.state.liq; i++) e.step(); // 30 tick 内必爆
  assert('T7 闪崩后强平', e.state.liq === true, { liq: e.state.liq, lastLiq: e.state.lastLiq });
  if (e.state.lastLiq) {
    assert('T7 亏损口径>0', e.state.lastLiq.lost > 0, e.state.lastLiq.lost);
    assert('T7 结算含负债', typeof e.state.lastLiq.debt === 'number');
  }
  console.log('    剧本数据:', JSON.stringify(e.state.lastLiq));
}

/* T8 普通杠杆下强平：手动高杠杆买 -> 跌到净值<=0 */
{
  const e = new Engine();
  e.state.lev = 50;
  const code = 'HLT';
  const r = e.placeOrder('buy', code, 100000, 0, true); // 50x 杠杆满仓买入（市值≈2000万）
  assert('T8 高杠杆买入成交', r.ok && r.filled > 0, r);
  let liq = false;
  for (let i = 0; i < 200 && !liq; i++) { e.step(); liq = e.state.liq; }
  assert('T8 200tick 内触发强平（大概率）', liq, { liq });
}

/* T9 持久化可序列化（JSON 无死循环） */
{
  const e = new Engine();
  e.placeOrder('buy', 'TAL', 5, 0, true);
  e.step();
  const s = JSON.stringify(e.state);
  assert('T9 state 可 JSON 序列化', typeof s === 'string' && s.length > 100, s.length);
}

/* T10 期货做空盈利：开空 → 价格跌 → 赚钱 */
{
  const e = new Engine();
  const code = 'SHG';
  const r = e.placeOrder('sell', code, 100, 0, true, true);    // 裸卖空 100 声骸
  assert('T10 裸空成功', r.ok && e.state.positions[code].qty === -100, r);
  const cashAfter = e.state.cash;
  assert('T10 开空现金增加', cashAfter > 300000, cashAfter);
  e.state.mk[code].mid = e.state.mk[code].mid * 0.7;           // 强跌 30%
  const pnl = (e.state.mk[code].mid - e.state.positions[code].avg) * e.state.positions[code].qty;
  assert('T10 下跌空单盈利', pnl > 0, pnl);
}

/* T11 期货做空亏损：价格涨 → 亏钱且净值下降 */
{
  const e = new Engine();
  const code = 'YSS';
  const before = e.netWorth();
  e.placeOrder('sell', code, 200, 0, true, true);
  e.state.mk[code].mid = e.state.mk[code].mid * 1.1;           // 涨 10%
  const pos = e.state.positions[code];
  const pnl = (e.state.mk[code].mid - pos.avg) * pos.qty;
  assert('T11 上涨空单亏损', pnl < 0, pnl);
  assert('T11 净值下降', e.netWorth() < before, { before, now: e.netWorth() });
}

/* T12 外汇 tab 不能裸空（已有 T5 空仓卖出拒单，这里验证带仓后超卖也拒） */
{
  const e = new Engine();
  e.placeOrder('buy', 'TVT', 10, 0, true);                     // 持多 10
  const r = e.placeOrder('sell', 'TVT', 999, 0, true, false);  // 超卖平仓不允裸空
  const pos = e.state.positions['TVT'];
  assert('T12 外汇禁止超卖开空', pos && pos.qty > -1e-9 && pos.qty <= 10, pos);
}

/* T13 期货到期自动结算 */
{
  const e = new Engine();
  const code = 'FSC';
  e.placeOrder('buy', code, 50, 0, true, true);
  const pos = e.state.positions[code];
  assert('T13 期货仓带到期标记', pos && pos.expiry > 0, pos);
  pos.expiry = 1;                                              // 强制到期
  e.step();
  assert('T13 到期已平仓', !(e.state.positions[code] && Math.abs(e.state.positions[code].qty) > 1e-9), e.state.positions[code]);
  const lastFill = e.state.fills[0];
  assert('T13 有到期结算记录', lastFill && lastFill.note === '合约到期结算', lastFill);
}

/* T14 空头爆仓：价格拉到净值穿零 → 强平 */
{
  const e = new Engine();
  const code = 'SHG';
  e.placeOrder('sell', code, 2000, 0, true, true);             // 开空 2000
  e.state.mk[code].mid = 500;                                  // 暴涨到净值穿零
  e._checkLiquidation();
  assert('T14 空头穿零强平', e.state.liq === true, { liq: e.state.liq, lastLiq: e.state.lastLiq });
  if (e.state.lastLiq) assert('T14 原因含强平', e.state.lastLiq.reason.indexOf('强制平仓') >= 0 || e.state.lastLiq.reason.indexOf('强平') >= 0, e.state.lastLiq.reason);
}

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
process.exit(fail ? 1 : 0);