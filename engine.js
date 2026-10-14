/* ============================================================================
 * Kurumi FX 核心引擎 v2
 * 纯逻辑模块，不依赖 DOM，可直接 node 运行测试。
 * 基准货币：久久币（JJB）—— 原型来自《FX战士久留美》女主角久留美。
 * 外汇语义：1 单位国家货币 = X JJB（X = mid）。
 * 期货语义：游戏物资合约，支持做空（qty 为负）与到期自动结算。
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

/* ---------------- 期货品种表：加一个品种 = 加一行 ----------------
 * 同样走行情/撮合/杠杆/强平引擎，额外支持：做空（qty 为负）+ 到期结算。
 * ------------------------------------------------------------------*/
const COMMODITIES = {
  FSC: { name: '风神瞳', city: '蒙德',   vendor: '提瓦特交易所', base: 66.6, vol: 0.0030 },
  YSS: { name: '源石',   city: '塔卫二', vendor: '罗德岛贸易站', base: 88.8, vol: 0.0034 },
  SHG: { name: '声骸',   city: '今州',   vendor: '声骸市场',     base: 55.5, vol: 0.0032 },
  JZ:  { name: '晶簇',   city: '海特洛', vendor: '粉爪交易所',   base: 99.9, vol: 0.0028 },
};

/* 统一配置查找表 */
const ALL = Object.assign({}, COUNTRIES, COMMODITIES);
const FUT_CODES = Object.keys(COMMODITIES);
const FUT_TTL = 60000;                 // 期货合约到期时限（毫秒）

const DEFAULT_LEV = 1;                 // 默认杠杆 1 倍
const LEV_OPTIONS = [1, 2, 5, 10, 50, 'inf'];   // 可选杠杆档位
const START_CASH = 300000;             // 初始久久币（久留美开局 30 万）
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
    this.fxCodes = Object.keys(COUNTRIES);
    this.futCodes = FUT_CODES;
    this.allCodes = this.fxCodes.concat(this.futCodes);
    this.state = {
      cash: START_CASH,          // 久久币余额（为负 = 融资负债）
      lev: DEFAULT_LEV,          // 杠杆档位：1/2/5/10/50/'inf'
      positions: {},             // { [code]: { qty(可负=空), avg(均价), expiry(期货到期ms,0=无) } }
      orders: [],                // 限价挂单
      fills: [],                 // 最近成交
      trades: 0, equity: [], peak: 0, maxDD: 0, netStart: null,
      holding: false, liq: false, sayN: 0,
      evIdx: -1, evEnd: 0, evMult: 0, netAtEntry: 0,
      crash: null,               // { code, left }
      lastLiq: null,             // 最近一次爆仓/到期结算信息
      // 行情（外汇 + 期货，每品种一个）
      mk: {},
    };
    for (const c of this.allCodes) this.state.mk[c] = this._seedMarket(c);
  }

  /* ---------- 行情：预生成历史 K 线 + 盘口 ---------- */
  _seedMarket(code) {
    const cfg = ALL[code];
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
      if (!mk.asks[i]) mk.asks[i] = { p: 0, v: Math.round(60 + Math.random() * 380) };   // 首建档位直接给深度
      if (!mk.bids[i]) mk.bids[i] = { p: 0, v: Math.round(60 + Math.random() * 380) };
      mk.asks[i].p = mk.mid + gap * (i + 1);
      mk.bids[i].p = mk.mid - gap * (i + 1);
      mk.asks[i].v = clamp((mk.asks[i].v || 0) + (Math.random() * 2 - 1) * 70, 30, 2600);
      mk.bids[i].v = clamp((mk.bids[i].v || 0) + (Math.random() * 2 - 1) * 70, 30, 2600);
    }
  }

  /* ---------- 行情推进：均值回归 + 事件冲击 + 闪崩 ---------- */
  walk(code) {
    const cfg = ALL[code];
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
    const floorN = cfg.base * (this.state.crash && this.state.crash.code === code && this.state.crash.left >= 0 ? CRASH_FLOOR : NORMAL_FLOOR);
    mk.mid = clamp(mk.mid * (1 + chg), floorN, cfg.base * 1.32);
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
  posValue() {                                                // 持仓总市值（空单 qty 为负，自然扣减）
    let v = 0;
    for (const c of this.allCodes) {
      const pos = this.state.positions[c];
      if (pos && Math.abs(pos.qty) > 1e-9) v += pos.qty * this.state.mk[c].mid;
    }
    return v;
  }
  netWorth() { return this.state.cash + this.posValue(); }   // 净值 = 现金 + 持仓市值
  levText() { return this.state.lev === 'inf' ? '∞' : this.state.lev + '×'; }

  /* ---------- 撮合：吃对手盘，逐档消耗 ----------
   * budget: 买入预算上限；sweep: 允许吃穿盘口（市价单/强平/做空），
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
    const cfg = ALL[code];
    const mk = this.state.mk[code];
    const imp = Math.min(IMPACT_CAP, filled * mk.mid / 180000 * 0.01);
    mk.mid = clamp(mk.mid * (1 + (side === 'buy' ? 1 : -1) * imp), cfg.base * 0.7, cfg.base * 1.34);
    this._syncBook(mk, cfg);
  }

  /* ---------- 记账（统一多空） ----------
   * delta > 0 买入（付钱），delta < 0 卖出/做空（收钱），delta 可与现仓反向（平仓/反手）。
   * 持仓格式 { qty, avg, expiry }，盈亏统一 = (mid - avg) × qty。 */
  _bookTrade(code, delta, px, isFut) {
    const pos = this.state.positions[code] || { qty: 0, avg: 0, expiry: 0 };
    const oldQty = pos.qty, newQty = r2(oldQty + delta);
    this.state.cash = r2(this.state.cash - delta * px);       // 买负现金流、卖正现金流
    if (Math.abs(newQty) < 1e-9) {
      delete this.state.positions[code];
    } else {
      if (oldQty === 0 || delta * oldQty > 0) {               // 开新仓 / 同向加仓：加权均价
        pos.avg = (Math.abs(oldQty) * pos.avg + Math.abs(delta) * px) / Math.abs(newQty);
      } else if (Math.abs(delta) > Math.abs(oldQty)) {        // 平仓并反手：新仓按现价
        pos.avg = px;
      }                                                       // 纯平仓：avg 不动
      pos.qty = newQty;
      if (isFut && oldQty === 0) pos.expiry = Date.now() + FUT_TTL;   // 期货新仓登记到期
      else if (isFut && pos.expiry === 0) pos.expiry = Date.now() + FUT_TTL;   // 空仓加仓后补偿
      else if (!isFut) pos.expiry = 0;
      this.state.positions[code] = pos;
    }
  }

  /* ---------- 下单 ----------
   * allowShort: 允许裸卖空（期货 tab）；外汇 tab 同侧仓位不足则拒单。 */
  placeOrder(side, code, qty, limit, isMarket, allowShort) {
    if (!qty || qty <= 0) return { ok: false, msg: '请输入委托数量' };
    if (!isMarket && (!limit || limit <= 0)) return { ok: false, msg: '请输入委托价格' };
    const pos = this.state.positions[code];
    const posQty = pos ? pos.qty : 0;
    const isFut = this.futCodes.indexOf(code) >= 0;

    /* ---- 买入 ---- */
    if (side === 'buy') {
      // 平空（买回）不卡预算；开多/加多按购买力限制
      const isCover = posQty < -1e-9;                          // 现为空头 → 买回 = 平空
      const budget = isCover ? null : this.buyingPower();
      if (!isCover && !(budget > 0)) return { ok: false, msg: '久久币余额不足' };
      const res = this._match(side, code, qty, limit, isMarket, budget, isMarket);
      if (res.filled > 0) {
        this._bookTrade(code, res.filled, res.avg, isFut);
        this._pushFill(side, code, res.avg, res.filled);
      }
      if (!isMarket && res.remain > 1e-6) {
        if (isCover) return { ok: false, msg: '盘口深度不足，无法挂单平空' };
        const need = limit * res.remain;
        if (need <= this.buyingPower() + 1e-6) {
          this._postOrder(side, code, res.remain, limit);
          return { ok: true, filled: res.filled, remain: res.remain, msg: '部分成交，剩余已挂单' };
        }
        if (res.filled <= 0) return { ok: false, msg: '资金不足，无法挂单' };
      }
      return { ok: true, filled: res.filled, remain: res.remain };
    }

    /* ---- 卖出 ---- */
    const hasPos = Math.abs(posQty) > 1e-9;
    if (hasPos && !allowShort && posQty >= -1e-9 && qty > posQty + 1e-9) {
      return { ok: false, msg: '持仓不足（外汇区不可裸空）' };   // 外汇区：只能平仓，超卖拒
    }
    if (!hasPos && !allowShort) return { ok: false, msg: '持仓不足' };   // 外汇 tab 不能裸空
    const res = this._match(side, code, qty, limit, isMarket, null, isMarket);
    if (res.filled > 0) {
      this._bookTrade(code, -res.filled, res.avg, isFut);
      this._pushFill(side, code, res.avg, res.filled);
    }
    if (!isMarket && res.remain > 1e-6) {
      this._postOrder(side, code, res.remain, limit);
      return { ok: true, filled: res.filled, remain: res.remain, msg: '部分成交，剩余已挂单' };
    }
    return { ok: true, filled: res.filled, remain: res.remain };
  }

  _postOrder(side, code, qty, limit) {
    this.state.orders.unshift({ id: Date.now() + Math.floor(Math.random() * 999), code, side, p: r2(limit), q: r2(qty), t: Date.now() });
  }
  cancelOrder(id) {
    this.state.orders = this.state.orders.filter(o => o.id !== id);
  }
  _pushFill(side, code, p, q, note) {
    const cfg = ALL[code];
    this.state.fills.unshift({ side, code, p: r2(p), q: r2(q), cur: cfg.currency || cfg.name, note: note || '', t: Date.now() });
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
      this._bookTrade(o.code, o.side === 'buy' ? res.filled : -res.filled, res.avg, this.futCodes.indexOf(o.code) >= 0);
      this._pushFill(o.side, o.code, res.avg, res.filled);
      this._impact(o.code, o.side, res.filled);
      o.q = r2(o.q - res.filled); changed = true;
      if (o.q <= 1e-6) this.state.orders.splice(i, 1);
    }
    return changed;
  }

  /* ---------- 主循环 ---------- */
  step() {
    for (const c of this.allCodes) this.walk(c);
    this.matchPending();
    this._settleExpired();
    this._trackEquity();
    this._checkLiquidation();
    this._rollEvent();
  }

  /* 期货到期：按市价自动全平对应合约 */
  _settleExpired() {
    const now = Date.now();
    for (const c of this.allCodes) {
      const pos = this.state.positions[c];
      if (!pos || Math.abs(pos.qty) < 1e-9 || !(pos.expiry > 0) || now < pos.expiry) continue;
      const qty = pos.qty;
      const side = qty > 0 ? 'sell' : 'buy';                     // 多单卖出平，空单买回平
      const res = this._match(side, c, Math.abs(qty), 0, true, null, true);
      if (res.filled > 0) {
        this._bookTrade(c, qty > 0 ? -res.filled : res.filled, res.avg, true);
        this._pushFill(side, c, res.avg, res.filled, '合约到期结算');
        this._impact(c, side, res.filled);
      } else {
        delete this.state.positions[c];
      }
      this.state.lastLiq = { reason: '合约到期结算 · ' + ALL[c].name, lost: 0, debt: r2(this.tradeDebt()), net: r2(this.netWorth()) };
    }
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

  /* ---------- 强平：净值穿零且还有仓位时全平 ---------- */
  _checkLiquidation() {
    if (this.state.liq) return;
    const anyPos = this.allCodes.some(c => Math.abs((this.state.positions[c] || {}).qty || 0) > 1e-9);
    if (!anyPos) {
      if (this.state.holding) { this.state.holding = false; this.state.crash = null; }
      return;
    }
    const forced = this.state.crash && this.state.crash.left <= 0;
    if (forced || this.netWorth() <= 0) this.liquidate(forced ? '闪崩后强制平仓' : '保证金耗尽，强制平仓');
  }

  liquidate(reason) {
    const base = this.state.netAtEntry > 0 ? this.state.netAtEntry : this.netWorth();
    for (const c of this.allCodes) {
      const pos = this.state.positions[c];
      if (!pos || Math.abs(pos.qty) < 1e-9) continue;
      const qty = pos.qty;
      const side = qty > 0 ? 'sell' : 'buy';                     // 多单卖出平，空单买回平
      const res = this._match(side, c, Math.abs(qty), 0, true, null, true);
      if (res.filled > 0) {
        this._bookTrade(c, qty > 0 ? -res.filled : res.filled, res.avg, this.futCodes.indexOf(c) >= 0);
        this._pushFill(side, c, res.avg, res.filled, reason);
      } else {
        delete this.state.positions[c];
      }
    }
    const lost = Math.max(0, base - this.netWorth());
    this.state.holding = false; this.state.liq = true; this.state.crash = null;
    this.state.lastLiq = { reason, lost: r2(lost), debt: r2(this.tradeDebt()), net: r2(this.netWorth()) };
    this._trackEquity();
    return this.state.lastLiq;
  }

  /* ---------- 久留美：话术 + 推荐（主线推外汇货币） ---------- */
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
    const res = this.placeOrder('buy', adv.code, adv.qty, 0, true, false);
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
      // 旧存档兼容：{qty,cost} → {qty,avg}；行情缺失重建
      for (const c of this.allCodes) {
        if (!this.state.mk[c] || !this.state.mk[c].mid) this.state.mk[c] = this._seedMarket(c);
        const pos = this.state.positions[c];
        if (pos && pos.cost != null && pos.avg == null) { pos.avg = Math.abs(pos.qty) > 1e-9 ? pos.cost / pos.qty : 0; }
        if (pos && pos.expiry == null) pos.expiry = 0;
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
  window.Engine = Engine; window.COUNTRIES = COUNTRIES; window.COMMODITIES = COMMODITIES;
  window.LEV_OPTIONS = LEV_OPTIONS; window.EVENTS = EVENTS;
}
if (typeof module !== 'undefined' && module.exports) module.exports = { Engine, COUNTRIES, COMMODITIES, LEV_OPTIONS, EVENTS };