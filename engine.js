/* ============================================================================
 * Kurumi FX 核心引擎
 * 纯逻辑模块，不依赖 DOM，可直接 node 运行测试。
 * 基准货币：久久币（JJB）—— 原型来自《FX战士久留美》女主角久留美。
 * 汇率语义：1 单位国家货币 = X JJB（X = mid）。
 * 设计：均值回归行情 / 吃对手盘撮合 / 分级杠杆 / 净值强平。
 * 本文件为原创实现（仅借鉴公开项目思路），MIT 许可。
 * ==========================================================================*/
'use strict';

/* ---------------- 国家配置表：加一个国家 = 加一行 ----------------
 * key    : 内部标识（3 位大写）
 * name   : 国家/地区名（游戏世界观地域）
 * city   : 主城
 * currency: 该国货币中文名
 * code   : 货币代码（外汇风格 3 位）
 * bank   : 央行梗（游戏内真实机构，用于话术与事件）
 * base   : 汇率锚点（1 单位该国货币 = base JJB）
 * vol    : 每 tick 波动基数（越大越妖）
 * ------------------------------------------------------------------*/
const COUNTRIES = {
  TVT: { name: '提瓦特', city: '蒙德 / 璃月港', currency: '摩拉', code: 'MOR', bank: '北国银行',   base: 120.5, vol: 0.0016 },
  JZH: { name: '今州',   city: '今州城',       currency: '贝币', code: 'SHE', bank: '今州商会',   base: 45.8,  vol: 0.0020 },
  TAL: { name: '塔卫二', city: '终末地基地',   currency: '塔卫币', code: 'TAL', bank: '终末地工业', base: 88.0,  vol: 0.0024 },
  HLT: { name: '海特洛', city: '海特洛市',     currency: '方斯', code: 'HFS', bank: '粉爪银行',   base: 200.0, vol: 0.0018 },
};
/* 塔卫币为占位名 [TODO: 老板确认《明日方舟：终末地》官方货币后替换] */

const DEFAULT_LEV = 1;                 // 默认杠杆 1 倍
const LEV_OPTIONS = [1, 2, 5, 10, 50, 'inf'];   // 可选杠杆档位
const START_CASH = 100000;             // 初始久久币
const TICK_MS = 1000;                  // 行情 tick 间隔
const HIST = 90;                       // 预生成 K 线根数
const LV = 5;                          // 盘口档数
const MAX_LINE = 240;                  // 分时点缓存上限
const SPREAD = 0.0007;                 // 盘口档距（相对 mid）
const SWEEP_SLIP = 0.03;               // 吃穿盘口后的滑点
const IMPACT_CAP = 0.015;              // 单笔价格冲击上限
const CRASH_TICKS = 10;                // 闪崩持续 tick
const CRASH_FLOOR = 0.28;              // 闪崩最低价 = base × 0.28
const NORMAL_FLOOR = 0.72;             // 常规最低价 = base × 0.72
const EV_TTL = 16000;                  // 独家消息存活毫秒
const ADV_EPOCH = 16000;               // 行情锚定纪元（毫秒）

/* ---------------- 久留美话术（自写文案，按行情状态三态轮播） ---------------- */
const SAY_SCRIPT = [
  '懂外汇吗？不懂正好，跟着我买就完了，我盯盘比你吃饭都勤。',
  '你看这盘口，买盘在堆，庄家控着价呢——这种位置就是白捡钱。',
  '回调就是上车机会，等会涨起来你哭都来不及。',
  '放心，我师父当年就是靠这招在汇市翻身的，你犹豫的每一秒都在亏钱。',
  '手里那点久久币留着干嘛？生利息吗？杠杆一开，明天直接财务自由。',
];
const HOLD_SCRIPT = [
  '别卖！技术性回调而已，我见过比这狠十倍的，最后都拉回来了。',
  '拿住拿住，这时候卖了就是给庄家送钱。',
  '亏的是浮亏，割了才是真亏——这道理你懂吧？',
  '别慌，我再去打听打听消息，马上给你说法。',
];
const DONE_SCRIPT = '唉，行情不给面子……不过没关系，下一波更大，敢不敢再来一次？';

/* ---------------- 独家消息（游戏世界观套壳事件） ---------------- */
const EVENTS = [
  { tag: '独家', txt: '北国银行传出降息风声，摩拉恐遭暴力拉升',       target: 'TVT', mult: 28 },
  { tag: '内幕', txt: '今州商会暗中扫货贝币，汇率异动在即',           target: 'JZH', mult: 32 },
  { tag: '急报', txt: '塔卫二工业订单暴增，塔卫币遭神秘资金抢筹',     target: 'TAL', mult: 36 },
  { tag: '猛料', txt: '海特洛央行疑似干预汇市，方斯多空决战一触即发', target: 'HLT', mult: 40 },
];

/* ---------------- 工具 ---------------- */
const r2 = n => Math.round(n * 100) / 100;
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmtInt = n => Math.round(n).toLocaleString('zh-CN');
const fmtAmt = n => Math.round(n * 100).toLocaleString('zh-CN', { maximumFractionDigits: 2 });

/* ============================================================================
 * Engine
 * ==========================================================================*/
class Engine {
  constructor() {
    this.codes = Object.keys(COUNTRIES);
    this.state = {
      cash: START_CASH,          // 久久币余额（为负 = 融资负债）
      lev: DEFAULT_LEV,          // 杠杆档位：1/2/5/10/50/'inf'
      positions: {},             // { [code]: { qty, cost } } 加权成本
      orders: [],                // 限价挂单
      fills: [],                 // 最近成交
      trades: 0, equity: [], peak: 0, maxDD: 0, netStart: null,
      holding: false, liq: false, sayN: 0,
      evIdx: -1, evEnd: 0, evMult: 0, netAtEntry: 0,
      crash: null,               // { code, left }
      // 行情（每货币一个）
      mk: {},
    };
    for (const c of this.codes) this.state.mk[c] = this._seedMarket(c);
  }

  /* ---------- 行情：预生成历史 K 线 + 盘口 ---------- */
  _seedMarket(code) {
    const cfg = COUNTRIES[code];
    let p = cfg.base * (1 + (Math.random() * 2 - 1) * 0.02);
    const m1 = [];
    for (let i = 0; i < HIST; i++) {
      const o = p;
      const drift = (cfg.base - p) / cfg.base * 0.05;      // 向锚点回归
      const c = clamp(o * (1 + drift + (Math.random() * 2 - 1) * 0.004), cfg.base * 0.8, cfg.base * 1.2);
      m1.push({ o, h: Math.max(o, c), l: Math.min(o, c), c, v: Math.round(60 + Math.random() * 800) });
      p = c;
    }
    const mk = {
      mid: p, prevClose: p, high: p, low: p, vol: 0,
      asks: [], bids: [], line: m1.slice(-MAX_LINE).map(x => x.c), m1,
    };
    this._syncBook(mk, cfg);
    return mk;
  }

  _syncBook(mk, cfg) {
    const gap = mk.mid * SPREAD;
    mk.asks = mk.asks.length ? mk.asks : [];
    mk.bids = mk.bids.length ? mk.bids : [];
    for (let i = 0; i < LV; i++) {
      if (!mk.asks[i]) mk.asks[i] = { p: 0, v: 0 };
      if (!mk.bids[i]) mk.bids[i] = { p: 0, v: 0 };
      mk.asks[i].p = mk.mid + gap * (i + 1);
      mk.bids[i].p = mk.mid - gap * (i + 1);
      mk.asks[i].v = clamp((mk.asks[i].v || 0) + (Math.random() * 2 - 1) * 70, 30, 2600);
      mk.bids[i].v = clamp((mk.bids[i].v || 0) + (Math.random() * 2 - 1) * 70, 30, 2600);
    }
  }

  /* ---------- 行情推进：均值回归 + 事件冲击 + 闪崩 ---------- */
  walk(code) {
    const cfg = COUNTRIES[code];
    const mk = this.state.mk[code];
    const dev = (mk.mid - cfg.base) / cfg.base;
    let chg;
    if (this.state.crash && this.state.crash.code === code && this.state.crash.left > 0) {
      this.state.crash.left--;
      chg = -(0.10 + Math.random() * 0.08);                 // 闪崩：每 tick -10%~-18%
    } else {
      chg = -dev * 0.02 + (Math.random() * 2 - 1) * cfg.vol * 0.5;
      if (Math.random() < 0.06) chg += (Math.random() * 2 - 1) * cfg.vol * 2.5;  // 6% 概率异动
      chg = clamp(chg, -cfg.vol * 3, cfg.vol * 3);
    }
    const floor = this.state.crash && this.state.crash.code === code && this.state.crash.left >= 0
      ? cfg.base * CRASH_FLOOR : cfg.base * NORMAL_FLOOR;
    mk.mid = clamp(mk.mid * (1 + chg), floor, cfg.base * 1.32);
    mk.high = Math.max(mk.high, mk.mid);
    mk.low = Math.min(mk.low, mk.mid);
    mk.line.push(mk.mid);
    if (mk.line.length > MAX_LINE) mk.line.shift();
    const last = mk.m1[mk.m1.length - 1];
    if (last) {
      last.c = mk.mid; last.h = Math.max(last.h, mk.mid); last.l = Math.min(last.l, mk.mid);
      last.v += Math.round(20 + Math.random() * 120);
    } else {
      mk.m1.push({ o: mk.mid, h: mk.mid, l: mk.mid, c: mk.mid, v: Math.round(20 + Math.random() * 120) });
    }
    this._syncBook(mk, cfg);
  }

  /* ---------- 账户 ---------- */
  buyingPower() {
    const lev = this.state.lev;
    return lev === 'inf' ? Infinity : Math.max(0, this.state.cash) * lev;
  }
  tradeDebt() { return Math.max(0, -this.state.cash); }     // 融资负债 = 余额透支部分
  posValue() {                                                // 持仓总市值
    let v = 0;
    for (const c of this.codes) {
      const pos = this.state.positions[c];
      if (pos && pos.qty > 1e-9) v += pos.qty * this.state.mk[c].mid;
    }
    return v;
  }
  netWorth() { return this.state.cash + this.posValue(); }   // 净值 = 现金 + 市值（骨架阶段无借贷）
  levText() { return this.state.lev === 'inf' ? '∞' : this.state.lev + '×'; }

  /* ---------- 撮合：吃对手盘，逐档消耗 ----------
   * budget: 买入预算上限；sweep: 允许吃穿盘口（市价融资单/强平），
   * 剩余按最后档 ±3% 滑点成交，模拟隐藏深度。 */
  _match(side, code, qty, limit, isMarket, budget, sweep) {
    const mk = this.state.mk[code];
    const book = side === 'buy' ? mk.asks : mk.bids;
    let remain = qty, cost = 0, filled = 0;
    const levels = [];
    for (let i = 0; i < book.length && remain > 1e-9; i++) {
      const lv = book[i];
      if (!isMarket) {
        if (side === 'buy' && lv.p > limit + 1e-9) break;
        if (side === 'sell' && lv.p < limit - 1e-9) break;
      }
      if (lv.v <= 1e-9) continue;
      let take = Math.min(remain, lv.v);
      if (side === 'buy' && budget != null) {
        const room = (budget - cost) / lv.p;
        if (room <= 1e-9) break;
        take = Math.min(take, room);
      }
      if (take <= 1e-9) break;
      cost += take * lv.p; remain -= take; filled += take; lv.v -= take;
      levels.push({ p: lv.p, v: take });
    }
    if (isMarket && sweep && remain > 1e-9 && book.length) {
      const last = book[book.length - 1].p;
      const px = last * (side === 'buy' ? 1 + SWEEP_SLIP : 1 - SWEEP_SLIP);
      cost += remain * px; filled += remain;
      levels.push({ p: px, v: remain });
      remain = 0;
    }
    return { filled: r2(filled), cost: r2(cost), remain: r2(remain), avg: filled > 0 ? cost / filled : 0 };
  }

  /* 只读试算（不改盘口） */
  quote(side, code, qty, limit, isMarket) {
    const mk = this.state.mk[code];
    const book = side === 'buy' ? mk.asks : mk.bids;
    let remain = qty, cost = 0, filled = 0;
    for (const lv of book) {
      if (remain <= 1e-9) break;
      if (!isMarket) {
        if (side === 'buy' && lv.p > limit + 1e-9) break;
        if (side === 'sell' && lv.p < limit - 1e-9) break;
      }
      if (lv.v <= 1e-9) continue;
      const take = Math.min(remain, lv.v);
      cost += take * lv.p; remain -= take; filled += take;
    }
    return { filled: r2(filled), cost: r2(cost), remain: r2(remain), avg: filled > 0 ? cost / filled : 0 };
  }

  /* 大单价格冲击：成交后把 mid 推向成交方向，最多 IMPACT_CAP */
  _impact(code, side, filled) {
    if (filled <= 0) return;
    const cfg = COUNTRIES[code];
    const mk = this.state.mk[code];
    const imp = Math.min(IMPACT_CAP, filled * mk.mid / 180000 * 0.01);
    mk.mid = clamp(mk.mid * (1 + (side === 'buy' ? 1 : -1) * imp), cfg.base * 0.7, cfg.base * 1.34);
    this._syncBook(mk, cfg);
  }

  /* ---------- 记账 ---------- */
  _bookBuy(code, filled, cost) {
    const pos = this.state.positions[code] || { qty: 0, cost: 0 };
    pos.qty += filled; pos.cost += cost;
    this.state.positions[code] = pos;
    this.state.cash = r2(this.state.cash - cost);
    this.state.mk[code].vol += filled;
  }
  _bookSell(code, filled, cost) {
    const pos = this.state.positions[code];
    if (pos && pos.qty > 1e-9) {
      const avg = pos.qty > 0 ? pos.cost / pos.qty : 0;
      const use = Math.min(filled, pos.qty);
      pos.qty -= use; pos.cost -= avg * use;
      if (pos.qty <= 1e-9) delete this.state.positions[code];
    }
    this.state.cash = r2(this.state.cash + cost);
    this.state.mk[code].vol += filled;
  }

  /* ---------- 下单 ---------- */
  placeOrder(side, code, qty, limit, isMarket) {
    if (!qty || qty <= 0) return { ok: false, msg: '请输入委托数量' };
    if (!isMarket && (!limit || limit <= 0)) return { ok: false, msg: '请输入委托价格' };
    if (side === 'buy') {
      const budget = this.buyingPower();
      if (!(budget > 0)) return { ok: false, msg: '久久币余额不足' };
      const res = this._match(side, code, qty, limit, isMarket, budget, !!(isMarket && this.state.lev !== 1));
      if (res.filled > 0) {
        this._bookBuy(code, res.filled, res.cost);
        this._pushFill(side, code, res.avg, res.filled);
        this._impact(code, side, res.filled);
      }
      if (!isMarket && res.remain > 1e-6) {
        const need = limit * res.remain;
        if (need <= this.buyingPower() + 1e-6) this._postOrder(side, code, res.remain, limit);
        else if (res.filled <= 0) return { ok: false, msg: '资金不足，无法挂单' };
      }
      return res.filled > 0 ? { ok: true, filled: res.filled, remain: res.remain } : { ok: true, filled: 0, msg: '已挂单等待成交' };
    }
    const pos = this.state.positions[code];
    if (!pos || pos.qty < qty - 1e-9) return { ok: false, msg: '持仓不足' };
    const res = this._match(side, code, qty, limit, isMarket, null, false);
    if (res.filled > 0) {
      this._bookSell(code, res.filled, res.cost);
      this._pushFill(side, code, res.avg, res.filled);
      this._impact(code, side, res.filled);
    }
    if (!isMarket && res.remain > 1e-6 && pos.qty >= res.remain - 1e-9) this._postOrder(side, code, res.remain, limit);
    return { ok: true, filled: res.filled, remain: res.remain };
  }

  _postOrder(side, code, qty, limit) {
    this.state.orders.unshift({ id: Date.now() + Math.floor(Math.random() * 999), code, side, p: r2(limit), q: r2(qty), t: Date.now() });
  }
  cancelOrder(id) {
    this.state.orders = this.state.orders.filter(o => o.id !== id);
  }
  _pushFill(side, code, p, q) {
    const cfg = COUNTRIES[code];
    this.state.fills.unshift({ side, code, p: r2(p), q: r2(q), cur: cfg.currency, t: Date.now() });
    if (this.state.fills.length > 30) this.state.fills.length = 30;
    this.state.trades++;
  }

  /* 挂单逐秒撮合 */
  matchPending() {
    let changed = false;
    for (let i = this.state.orders.length - 1; i >= 0; i--) {
      const o = this.state.orders[i];
      const res = this._match(o.side, o.code, o.q, o.p, false, null, false);
      if (res.filled <= 0) continue;
      if (o.side === 'buy') this._bookBuy(o.code, res.filled, res.cost);
      else this._bookSell(o.code, res.filled, res.cost);
      this._pushFill(o.side, o.code, res.avg, res.filled);
      this._impact(o.code, o.side, res.filled);
      o.q = r2(o.q - res.filled); changed = true;
      if (o.q <= 1e-6) this.state.orders.splice(i, 1);
    }
    return changed;
  }

  /* ---------- 主循环 ---------- */
  step() {
    for (const c of this.codes) this.walk(c);
    this.matchPending();
    this._trackEquity();
    this._checkLiquidation();
    this._rollEvent();
  }

  /* ---------- 战绩 ---------- */
  _trackEquity() {
    const n = this.netWorth();
    if (this.state.netStart === null) this.state.netStart = n;
    this.state.equity.push(n);
    if (this.state.equity.length > MAX_LINE) this.state.equity.shift();
    if (n > this.state.peak) this.state.peak = n;
    const dd = this.state.peak > 0 ? (this.state.peak - n) / this.state.peak : 0;
    if (dd > this.state.maxDD) this.state.maxDD = dd;
  }

  /* ---------- 强平：净值耗尽（cash 为负且净值<=0）时全平持仓 ---------- */
  _checkLiquidation() {
    if (this.state.liq) return;
    const anyPos = this.codes.some(c => (this.state.positions[c] || {}).qty > 1e-9);
    if (!anyPos) {
      if (this.state.holding) { this.state.holding = false; this.state.crash = null; }
      return;
    }
    const forced = this.state.crash && this.state.crash.left <= 0;
    if (forced || (this.tradeDebt() > 0 && this.netWorth() <= 0)) this.liquidate(forced ? '闪崩后强制平仓' : '保证金耗尽，强制平仓');
  }

  liquidate(reason) {
    const base = this.state.netAtEntry > 0 ? this.state.netAtEntry : this.netWorth();
    let proceeds = 0;
    for (const c of this.codes) {
      const pos = this.state.positions[c];
      if (!pos || pos.qty <= 1e-9) continue;
      const res = this._match('sell', c, pos.qty, 0, true, null, true);
      if (res.filled > 0) {
        this._bookSell(c, res.filled, res.cost);
        this._pushFill('sell', c, res.avg, res.filled);
        proceeds += res.cost;
      }
    }
    const lost = Math.max(0, base - this.netWorth());
    this.state.holding = false; this.state.liq = true; this.state.crash = null;
    this.state.lastLiq = { reason, lost: r2(lost), debt: r2(this.tradeDebt()), net: r2(this.netWorth()) };
    this._trackEquity();
    return this.state.lastLiq;
  }

  /* ---------- 久留美：话术 + 推荐 ---------- */
  currentEvent() {
    const now = Date.now();
    if (this.state.evIdx < 0 || now >= this.state.evEnd) {
      let i = Math.floor(Math.random() * EVENTS.length);
      while (EVENTS.length > 1 && i === this.state.evIdx) i = Math.floor(Math.random() * EVENTS.length);
      this.state.evIdx = i; this.state.evEnd = now + EV_TTL;
    }
    return EVENTS[this.state.evIdx];
  }
  _rollEvent() { this.currentEvent(); }   // 预热事件（含倒计时轮换）
  advice() {
    const ev = this.currentEvent();
    this.state.evMult = ev.mult;
    const code = ev.target;
    const cfg = COUNTRIES[code];
    const mk = this.state.mk[code];
    const depth = mk.bids.reduce((s, l) => s + l.v, 0);
    const qty = Math.max(1, Math.floor(depth * ev.mult));
    let say;
    if (this.state.liq) say = DONE_SCRIPT;
    else if (this.state.holding) say = HOLD_SCRIPT[this.state.sayN++ % HOLD_SCRIPT.length];
    else say = SAY_SCRIPT[this.state.sayN++ % SAY_SCRIPT.length];
    const evLeft = Math.max(0, Math.ceil((this.state.evEnd - Date.now()) / 1000));
    return { say, ev, evLeft, code, cfg, mk, qty, plan: qty * mk.mid };
  }

  /* 一键同意：∞ 杠杆市价满仓买 target，随后闪崩探底（100% 爆仓剧本） */
  acceptAdvice() {
    const adv = this.advice();
    if (this.state.liq || this.state.holding) return { ok: false, msg: '当前不可下单' };
    this.state.lev = 'inf';
    this.state.netAtEntry = this.netWorth();
    const res = this.placeOrder('buy', adv.code, adv.qty, 0, true);
    if (!res.ok) { this.state.lev = DEFAULT_LEV; return res; }
    this.state.holding = true;
    this.state.crash = { code: adv.code, left: CRASH_TICKS };
    return { ok: true, ...res };
  }

  /* ---------- 存档 ---------- */
  persist() {
    try { localStorage.setItem('kurumi-fx.state.v1', JSON.stringify(this.state)); } catch (e) { /* 存储不可用时静默降级 */ }
  }
  load() {
    try {
      const raw = localStorage.getItem('kurumi-fx.state.v1');
      if (!raw) return false;
      const saved = JSON.parse(raw);
      if (!saved || typeof saved.cash !== 'number') return false;
      for (const k of Object.keys(saved)) this.state[k] = saved[k];
      // 存档可能缺新增国家的行情（旧存档兼容）：缺了就重建
      for (const c of this.codes) {
        if (!this.state.mk[c] || !this.state.mk[c].mid) this.state.mk[c] = this._seedMarket(c);
      }
      return true;
    } catch (e) { return false; }
  }
  reset() {
    try { localStorage.removeItem('kurumi-fx.state.v1'); } catch (e) { /* 忽略 */ }
    Object.assign(this, new Engine());
  }
}

/* 测试钩子：浏览器挂 window，node 挂 module.exports */
if (typeof window !== 'undefined') {
  window.Engine = Engine; window.COUNTRIES = COUNTRIES;
  window.LEV_OPTIONS = LEV_OPTIONS; window.EVENTS = EVENTS;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { Engine, COUNTRIES, LEV_OPTIONS, EVENTS };