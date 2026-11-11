/*
 * Band Calibration core: TXSE Participation Bands (Rule 11.022(a)(20), circular of Sep 9 2026),
 * TXSE auction price determination with Late Auction Order clamping, a seeded closing-auction
 * simulator, and per-method split-conformal calibration of the band parameters with a
 * notice-aware walk-forward backtest.
 *
 * All prices are integer ticks (cents). Works in the browser (window.Bands) and in Node (require).
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.Bands = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  // ---------------------------------------------------------------- random numbers
  function mulberry32(a) {
    return function () {
      a |= 0; a = (a + 0x6D2B79F5) | 0;
      var t = Math.imul(a ^ (a >>> 15), 1 | a);
      t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
      return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
    };
  }
  function makeRng(seed) {
    var u = mulberry32(seed >>> 0), spare = null;
    var r = {
      u: u,
      normal: function () {
        if (spare !== null) { var s = spare; spare = null; return s; }
        var a = u() || 1e-12, b = u();
        var m = Math.sqrt(-2 * Math.log(a));
        spare = m * Math.sin(2 * Math.PI * b);
        return m * Math.cos(2 * Math.PI * b);
      },
      // Student t with nu degrees of freedom, scaled to unit variance (nu > 2)
      t: function (nu) {
        var z = r.normal(), c = 0;
        for (var i = 0; i < nu; i++) { var g = r.normal(); c += g * g; }
        return z / Math.sqrt(c / nu) * Math.sqrt((nu - 2) / nu);
      },
      poisson: function (lam) {
        if (lam <= 0) return 0;
        if (lam > 40) return Math.max(0, Math.round(lam + Math.sqrt(lam) * r.normal()));
        var L = Math.exp(-lam), k = 0, p = 1;
        do { k++; p *= u(); } while (p > L);
        return k - 1;
      }
    };
    return r;
  }

  // ---------------------------------------------------------------- statistics helpers
  function median(a) {
    if (!a.length) return NaN;
    var s = a.slice().sort(function (x, y) { return x - y; }), n = s.length, h = n >> 1;
    return n % 2 ? s[h] : (s[h - 1] + s[h]) / 2;
  }
  function mad(a, m) { return median(a.map(function (x) { return Math.abs(x - m); })); }
  // Split-conformal quantile: the ceil((n+1)(1-alpha))-th smallest score (Infinity if it does not exist).
  function conformalQuantile(scores, alpha) {
    var s = scores.slice().sort(function (x, y) { return x - y; }), n = s.length;
    var idx = Math.ceil((n + 1) * (1 - alpha)) - 1;
    if (n === 0 || idx >= n) return Infinity;
    return s[Math.max(0, idx)];
  }

  // ---------------------------------------------------------------- production parameters
  // TXSE Auction Participation Bands: Methodology and Parameter Values (circular issued Sep 9 2026)
  var PRODUCTION = {
    windowSec: 300, minTrades: 50, minMids: 50, tradeK: 5.0, quoteK: 5.0, minNotional: 0,
    refWidthPct: 0.0125, mpvFloor: 5, bpsFloor: 5, maxHalfPct: 0.025, wideSpreadPct: 0.05
  };
  var RANGES = {
    tradeK: [1, 10], quoteK: [1, 10], refWidthPct: [0.005, 0.025],
    mpvFloor: [3, 10], bpsFloor: [1, 25], maxHalfPct: [0.01, 0.05]
  };
  function withParams(over) { var p = {}, k; for (k in PRODUCTION) p[k] = PRODUCTION[k]; for (k in over || {}) p[k] = over[k]; return p; }

  // ---------------------------------------------------------------- Participation Bands
  // ev: { trades:[{px, sz, flag}], quotes:[{bid, ask}], lastSale, priorClose }  (ticks)
  // Returns the k-independent basis: method in use, midpoint and MAD (null for the Reference Price Method).
  function bandBasis(ev, p) {
    var elig = ev.trades.filter(function (t) { return !t.flag; });
    var notional = 0; elig.forEach(function (t) { notional += t.px * t.sz / 100; });
    if (elig.length >= p.minTrades && notional >= p.minNotional) {
      var P = elig.map(function (t) { return t.px; }), m = median(P);
      return { method: 'trade', mid: m, mad: mad(P, m), n: P.length };
    }
    var mids = [];
    ev.quotes.forEach(function (q) {
      if (!(q.bid > 0) || !(q.ask > 0)) return;          // one-sided (zero/negative NBB is not a bid)
      if (q.ask <= q.bid) return;                          // crossed or locked
      var mid = (q.bid + q.ask) / 2;
      if (q.ask - q.bid > p.wideSpreadPct * mid) return;   // extremely wide
      mids.push(mid);
    });
    if (mids.length >= p.minMids) {
      var mq = median(mids);
      return { method: 'quote', mid: mq, mad: mad(mids, mq), n: mids.length };
    }
    var ref;
    if (elig.length) {
      var v = 0, q2 = 0; elig.forEach(function (t) { v += t.px * t.sz; q2 += t.sz; }); ref = v / q2;
    } else if (mids.length) ref = median(mids);
    else if (ev.lastSale != null) ref = ev.lastSale;
    else ref = ev.priorClose;
    return { method: 'reference', mid: ref, mad: null, n: 0 };
  }

  function halfWidth(basis, p) {
    var minHW = Math.max(p.mpvFloor * 1, p.bpsFloor * 1e-4 * basis.mid);
    var maxHW = p.maxHalfPct * basis.mid, h;
    if (basis.method === 'reference') h = p.refWidthPct * basis.mid;
    else {
      var k = basis.method === 'trade' ? p.tradeK : p.quoteK;
      h = Math.min(k * basis.mad, maxHW);
    }
    return Math.max(h, minHW); // the Minimum Half-Width governs where it conflicts with the Maximum
  }
  function bandFrom(basis, p) {
    var h = halfWidth(basis, p);
    return { lower: Math.round(basis.mid - h), upper: Math.round(basis.mid + h), half: h, mid: basis.mid, method: basis.method };
  }

  // Smallest k (or Reference width) that would have kept price x inside the band, given the floors.
  function score(basis, x, p) {
    var minHW = Math.max(p.mpvFloor * 1, p.bpsFloor * 1e-4 * basis.mid), maxHW = p.maxHalfPct * basis.mid;
    // band edges are rounded to the nearest tick (half up): a price above the midpoint is inside when
    // h >= |x - mid| - 0.5, a price below it only when h is strictly greater
    var need = Math.abs(x - basis.mid) - 0.5 + (x < basis.mid ? 1e-9 : 0);
    if (need <= minHW) return 0;
    if (basis.method === 'reference') return need / basis.mid;
    if (need > Math.max(minHW, maxHW)) return Infinity;
    if (!(basis.mad > 0)) return Infinity;
    return need / basis.mad;
  }

  // ---------------------------------------------------------------- auction price determination
  // orders: {side:'B'|'S', qty, limit (ticks, null = market), late}
  // Rule 11.022: maximize executed shares; then minimum total imbalance; then the entered price at which
  // shares remain unexecuted; then the price closest to the Volume Based Tie Breaker (vbtb).
  function clear(orders, vbtb) {
    var set = {}; set[vbtb] = 1;
    orders.forEach(function (o) { if (o.limit != null) { set[o.limit] = 1; set[o.limit - 1] = 1; set[o.limit + 1] = 1; } });
    var cands = Object.keys(set).map(Number).sort(function (a, b) { return a - b; });
    var best = null;
    cands.forEach(function (px) {
      var buy = 0, sell = 0;
      orders.forEach(function (o) {
        if (o.side === 'B') { if (o.limit == null || o.limit >= px) buy += o.qty; }
        else if (o.limit == null || o.limit <= px) sell += o.qty;
      });
      var matched = Math.min(buy, sell), imb = Math.abs(buy - sell);
      var ex = buy > sell ? 'B' : sell > buy ? 'S' : null;
      var unexec = ex ? orders.some(function (o) { return o.side === ex && o.limit === px; }) : false;
      var c = { price: px, matched: matched, imbalance: imb, buy: buy, sell: sell, excess: ex, unexec: unexec, dist: Math.abs(px - vbtb) };
      if (!best || better(c, best)) best = c;
    });
    if (!best || best.matched === 0) return { price: null, matched: 0, imbalance: best ? best.imbalance : 0, excess: best ? best.excess : null };
    return best;
  }
  function better(a, b) {
    if (a.matched !== b.matched) return a.matched > b.matched;
    if (a.imbalance !== b.imbalance) return a.imbalance < b.imbalance;
    if (a.unexec !== b.unexec) return a.unexec;
    if (a.dist !== b.dist) return a.dist < b.dist;
    return a.price < b.price;
  }
  // Late Auction Orders priced more aggressively than the band are adjusted to the band.
  function applyBand(orders, lower, upper) {
    return orders.map(function (o) {
      if (!o.late || o.limit == null) return o;
      if (o.side === 'B' && o.limit > upper) return { side: o.side, qty: o.qty, limit: upper, late: true, clamped: true, orig: o.limit };
      if (o.side === 'S' && o.limit < lower) return { side: o.side, qty: o.qty, limit: lower, late: true, clamped: true, orig: o.limit };
      return o;
    });
  }
  // Late shares that were marketable at the unconstrained price but are priced out by the band.
  function pricedOut(orders, banded, pu) {
    var s = 0;
    for (var i = 0; i < orders.length; i++) {
      var o = orders[i], b = banded[i];
      if (!b.clamped) continue;
      var before = o.side === 'B' ? o.limit >= pu : o.limit <= pu;
      var after = b.side === 'B' ? b.limit >= pu : b.limit <= pu;
      if (before && !after) s += o.qty;
    }
    return s;
  }

  // ---------------------------------------------------------------- simulator
  // Symbols listed on TXSE (from the public Auction Viewer, Nov 10 2026). Prices are that day's official
  // closing prices; every other attribute is a synthetic profile.
  var SYMBOLS = [
    // sym, kind, price, annual vol, trades in last 5 min, quote updates in last 5 min, spread ticks, impact bps, auction shares
    ['ET', 'Stock', 19.43, 0.22, 900, 420, 1, 3, 110000],
    ['CECO', 'Stock', 51.83, 0.46, 230, 300, 3, 9, 80000],
    ['TXCP', 'Stock', 99.82, 0.33, 260, 320, 4, 7, 60000],
    ['IBOC', 'Stock', 67.85, 0.28, 170, 260, 3, 8, 45000],
    ['SUN', 'Stock', 63.21, 0.24, 190, 260, 3, 6, 26000],
    ['USAC', 'Stock', 25.52, 0.27, 130, 210, 2, 8, 25000],
    ['OBK', 'Stock', 54.24, 0.30, 75, 160, 4, 12, 25000],
    ['SUNC', 'Stock', 63.00, 0.30, 62, 130, 6, 14, 9000],
    ['DDS', 'Stock', 634.33, 0.42, 58, 190, 55, 14, 9000],
    ['ET.PRI', 'Preferred', 10.53, 0.08, 14, 70, 3, 10, 2500],
    ['TXCP.PRB', 'Preferred', 17.15, 0.10, 9, 55, 5, 14, 1500],
    ['ILS', 'ETP', 20.36, 0.07, 30, 140, 2, 6, 5000],
    ['DDT', 'ETP', 25.50, 0.18, 12, 95, 3, 10, 1500],
    ['TXS', 'ETP', 41.84, 0.20, 6, 85, 4, 10, 800],
    ['CTAG', 'ETP', 15.72, 0.16, 5, 75, 3, 10, 600],
    ['OILT', 'ETP', 30.84, 0.30, 5, 65, 4, 12, 600],
    ['ICOM', 'ETP', 23.82, 0.22, 3, 55, 4, 12, 500],
    ['FIFT', 'ETP', 26.33, 0.10, 3, 45, 4, 10, 500],
    ['PWRX', 'ETP', 23.75, 0.28, 3, 40, 5, 14, 400],
    ['THRU', 'ETP', 24.43, 0.25, 2, 35, 5, 14, 400],
    ['WSLS', 'ETP', 24.41, 0.18, 2, 30, 5, 12, 400],
    ['WTAL', 'ETP', 23.53, 0.20, 2, 25, 6, 14, 400]
  ].map(function (r) {
    return { sym: r[0], kind: r[1], price: r[2], vol: r[3], trades: r[4], quotes: r[5], spread: r[6], impactBps: r[7], shares: r[8] };
  });

  // 60 business days ending Mon Nov 9 2026 (Labor Day skipped). Event days get larger closing imbalances.
  function sessionDates() {
    var out = [], d = new Date(Date.UTC(2026, 10, 9));
    while (out.length < 60) {
      var wd = d.getUTCDay(), iso = d.toISOString().slice(0, 10);
      if (wd !== 0 && wd !== 6 && iso !== '2026-09-07') out.unshift(iso);
      d = new Date(d.getTime() - 86400000);
    }
    return out;
  }
  var EVENT_DAYS = { '2026-09-18': 'Quarterly index rebalance', '2026-09-30': 'Quarter end', '2026-10-30': 'Month end' };

  function simulateSession(s, date, rng, st) {
    var px = st.px;                               // efficient price at 3:53:00, ticks
    var ev = EVENT_DAYS[date] ? 2.6 : 1;
    st.lv = 0.8 * st.lv + 0.35 * rng.normal();    // AR(1) log-vol state (vol clustering across days)
    var volMult = Math.exp(st.lv - 0.3) * (ev > 1 ? 1.4 : 1);
    var sigSec = s.vol * volMult / Math.sqrt(252 * 23400) * px; // ticks per sqrt(second)
    // efficient path on a 1-second grid from 3:53:00 (t=-420) to 4:00:00 (t=0); ramp in the last two minutes
    var path = new Float64Array(421), x = px;
    var jumpAt = rng.u() < 0.03 ? Math.floor(rng.u() * 420) : -1;
    for (var i = 0; i <= 420; i++) {
      path[i] = x;
      var ramp = i >= 300 ? 1.6 : 1;
      x += sigSec * ramp * rng.normal();
      if (i === jumpAt) x += rng.t(3) * sigSec * Math.sqrt(300) * 2.5;
    }
    var at = function (t) { return path[Math.max(0, Math.min(420, Math.round(t + 420)))]; };
    var liq = Math.exp(0.45 * rng.normal() - 0.1);
    var half = s.spread / 2;
    // trades in the Observation Window [3:55:00, 4:00:00)
    var nT = rng.poisson(s.trades * liq * (ev > 1 ? 1.5 : 1)), trades = [];
    for (var j = 0; j < nT; j++) {
      var t = -300 + rng.u() * 300, side = rng.u() < 0.5 ? -1 : 1;
      var tp = Math.round(at(t) + side * half * (0.6 + 0.4 * rng.u()) + 0.3 * rng.normal());
      var flag = rng.u() < 0.01 ? (rng.u() < 0.5 ? 'corrected' : 'late') : null;
      if (flag) tp += Math.round(rng.normal() * 6 * half);
      trades.push({ t: t, px: tp, sz: 100 * (1 + Math.floor(rng.u() * 4)), flag: flag });
    }
    trades.sort(function (a, b) { return a.t - b.t; });
    // NBBO midpoint changes
    var nQ = rng.poisson(s.quotes * liq), quotes = [];
    for (var q = 0; q < nQ; q++) {
      var tq = -300 + rng.u() * 300, sp = Math.max(1, s.spread + Math.round(rng.normal() * 0.6));
      var bid = Math.floor(at(tq) - sp / 2), ask = bid + sp;
      var r = rng.u();
      if (r < 0.01) ask = bid;                 // locked
      else if (r < 0.015) bid = 0;             // one-sided
      quotes.push({ t: tq, bid: bid, ask: ask });
    }
    quotes.sort(function (a, b) { return a.t - b.t; });
    var lastSale = trades.length ? trades[trades.length - 1].px : null;
    var e0 = at(0), e358 = at(-120);
    // closing imbalance and the price the auction book wants to clear at
    var z = rng.t(3) * ev;
    var target = e0 + z * s.impactBps * 1e-4 * px;
    var V = s.shares * Math.exp(0.5 * rng.normal() - 0.12);
    var lot = function (f) { return Math.max(1, Math.round(V * f / 100)) * 100; };
    var w = Math.max(2, 0.6 * sigSec * Math.sqrt(300) + half);
    var orders = [];
    orders.push({ side: 'B', qty: lot(0.22 + (z > 0 ? 0.12 * Math.abs(z) : 0)), limit: null, late: false });
    orders.push({ side: 'S', qty: lot(0.22 + (z < 0 ? 0.12 * Math.abs(z) : 0)), limit: null, late: false });
    for (var b = 0; b < 5; b++) {
      orders.push({ side: 'B', qty: lot(0.03 + 0.03 * rng.u()), limit: Math.round(e358 - Math.abs(rng.normal()) * w), late: false });
      orders.push({ side: 'S', qty: lot(0.03 + 0.03 * rng.u()), limit: Math.round(e358 + Math.abs(rng.normal()) * w), late: false });
    }
    var bb = Math.floor(e0 - half), ba = bb + s.spread;  // displayed continuous book at the close
    for (var c = 0; c < 3; c++) {
      orders.push({ side: 'B', qty: lot(0.02), limit: bb - c, late: false, cont: true });
      orders.push({ side: 'S', qty: lot(0.02), limit: ba + c, late: false, cont: true });
    }
    for (var l = 0; l < 8; l++) {
      orders.push({ side: 'B', qty: lot(0.05 + 0.04 * rng.u()), limit: Math.round(target + rng.normal() * w), late: true });
      orders.push({ side: 'S', qty: lot(0.05 + 0.04 * rng.u()), limit: Math.round(target + rng.normal() * w), late: true });
    }
    var vbtb = Math.round(e0);
    var ev2 = { trades: trades, quotes: quotes, lastSale: lastSale, priorClose: st.lastClose };
    var u = clear(orders, vbtb);
    var pu = u.price != null ? u.price : vbtb;
    st.lastClose = pu;
    // overnight + next day to 3:53, mildly mean-reverting to the symbol's Nov 10 level so prices stay realistic
    st.px = path[420] + sigSec * Math.sqrt(23400 - 420) * 0.9 * rng.normal() + 0.08 * (st.anchor - path[420]);
    return {
      sym: s.sym, kind: s.kind, date: date, event: EVENT_DAYS[date] || null,
      ev: ev2, orders: orders, vbtb: vbtb, pu: pu, matched: u.matched, eff: e0
    };
  }

  function generate(seed) {
    var rng = makeRng(seed == null ? 20261110 : seed), dates = sessionDates(), sessions = [];
    var states = SYMBOLS.map(function (s) { return { px: Math.round(s.price * 100), anchor: Math.round(s.price * 100), lv: 0, lastClose: Math.round(s.price * 100) }; });
    dates.forEach(function (d, di) {
      SYMBOLS.forEach(function (s, si) {
        var x = simulateSession(s, d, rng, states[si]);
        x.day = di; sessions.push(x);
      });
    });
    return { dates: dates, symbols: SYMBOLS, sessions: sessions, seed: seed == null ? 20261110 : seed };
  }

  // ---------------------------------------------------------------- evaluation
  function evaluateSession(x, p) {
    var basis = x._basis || (x._basis = bandBasis(x.ev, PRODUCTION)); // method/mid/MAD do not depend on k or widths
    var band = bandFrom(basis, p);
    var inside = x.pu >= band.lower && x.pu <= band.upper;
    var res = { method: basis.method, lower: band.lower, upper: band.upper, half: band.half, mid: basis.mid, inside: inside,
      halfBps: band.half / basis.mid * 1e4, pb: x.pu, pricedOut: 0, dislocBps: 0 };
    if (!inside) {
      var banded = applyBand(x.orders, band.lower, band.upper);
      var c = clear(banded, x.vbtb);
      res.pb = c.price != null ? c.price : x.vbtb;
      res.pricedOut = pricedOut(x.orders, banded, x.pu);
      res.dislocBps = Math.abs(res.pb - x.pu) / x.pu * 1e4;
    }
    return res;
  }

  var METHODS = ['trade', 'quote', 'reference'];
  function paramKey(m) { return m === 'trade' ? 'tradeK' : m === 'quote' ? 'quoteK' : 'refWidthPct'; }

  // Per-method split-conformal calibration of k (Trade, Quote) and the Reference width, for fixed floors.
  function calibrateMethods(sessions, alpha, p0) {
    var p = p0 || PRODUCTION, out = {};
    METHODS.forEach(function (m) {
      var sc = [];
      sessions.forEach(function (x) {
        var b = x._basis || (x._basis = bandBasis(x.ev, PRODUCTION));
        if (b.method === m) sc.push(score(b, x.pu, p));
      });
      var key = paramKey(m), lo = RANGES[key][0], hi = RANGES[key][1];
      var q = conformalQuantile(sc, alpha), v, capped = false;
      if (m === 'reference') v = Math.ceil(q / 0.0005 - 1e-9) * 0.0005;  // 0.05% steps
      else v = Math.ceil(q * 10 - 1e-9) / 10;                            // 0.1 steps, like the circular's 5.0
      if (!isFinite(v) || v > hi) { v = hi; capped = true; }
      if (v < lo) v = lo;
      v = +v.toFixed(m === 'reference' ? 4 : 1);
      var misses = sc.filter(function (z) { return z > v + 1e-9; }).length;
      out[key] = { value: v, n: sc.length, quantile: q, capped: capped, misses: misses, scores: sc };
    });
    return out;
  }

  // Joint calibration over the circular's knobs: for every (MPV Floor, Basis Point Floor, Maximum Half-Width)
  // in the permissible grid, set each method's k / width by split conformal, then keep the combination with the
  // smallest excess of calibration misses over the target, and among those the narrowest mean band.
  var GRID = { mpvFloor: [3, 4, 5, 6, 7, 8, 9, 10], bpsFloor: [], maxHalfPct: [0.025, 0.05] };
  for (var gb = 1; gb <= 25; gb++) GRID.bpsFloor.push(gb);
  // `current` (optional): the floors in effect; they are kept unless another combination is more than
  // `stickiness` narrower, so the Exchange is not issuing a circular every week for a rounding difference.
  function calibrate(sessions, alpha, current, stickiness) {
    var best = null, keep = null, tol = stickiness == null ? 0.03 : stickiness;
    GRID.mpvFloor.forEach(function (mpv) {
      GRID.bpsFloor.forEach(function (bps) {
        GRID.maxHalfPct.forEach(function (mh) {
          var p = withParams({ mpvFloor: mpv, bpsFloor: bps, maxHalfPct: mh });
          var cm = calibrateMethods(sessions, alpha, p), excess = 0;
          METHODS.forEach(function (m) {
            var c = cm[paramKey(m)], allowed = Math.floor(alpha * (c.n + 1));
            excess += Math.max(0, c.misses - allowed);
          });
          p.tradeK = cm.tradeK.value; p.quoteK = cm.quoteK.value; p.refWidthPct = cm.refWidthPct.value;
          var h = 0; sessions.forEach(function (x) { var b = x._basis; h += halfWidth(b, p) / b.mid * 1e4; });
          h /= Math.max(1, sessions.length);
          var cand = { params: p, excess: excess, meanHalfBps: h, methods: cm };
          if (current && mpv === current.mpvFloor && bps === current.bpsFloor && mh === current.maxHalfPct) keep = cand;
          if (!best || cand.excess < best.excess || (cand.excess === best.excess && cand.meanHalfBps < best.meanHalfBps - 1e-9)) best = cand;
        });
      });
    });
    if (keep && keep.excess === best.excess && keep.meanHalfBps <= best.meanHalfBps * (1 + tol)) best = keep;
    var out = { tradeK: best.params.tradeK, quoteK: best.params.quoteK, refWidthPct: best.params.refWidthPct,
      mpvFloor: best.params.mpvFloor, bpsFloor: best.params.bpsFloor, maxHalfPct: best.params.maxHalfPct,
      feasible: best.excess === 0, meanHalfBps: best.meanHalfBps, n: sessions.length, perMethod: {} };
    METHODS.forEach(function (m) { var c = best.methods[paramKey(m)]; out.perMethod[m] = { n: c.n, misses: c.misses, capped: c.capped }; });
    return out;
  }

  // Walk-forward: recalibrate every `every` sessions on the trailing `window` sessions. A new value takes
  // effect after the circular's notice: 1 business day for reductions, 5 for increases.
  function walkForward(data, opt) {
    opt = opt || {};
    var alpha = opt.alpha == null ? 0.02 : opt.alpha, win = opt.window || 30, every = opt.every || 5;
    var start = opt.start == null ? 30 : opt.start, nDays = data.dates.length;
    var byDay = []; for (var d = 0; d < nDays; d++) byDay.push([]);
    data.sessions.forEach(function (x) { byDay[x.day].push(x); });
    var KEYS = ['tradeK', 'quoteK', 'refWidthPct', 'mpvFloor', 'bpsFloor', 'maxHalfPct'];
    var DECREASE_1DAY = { tradeK: 1, quoteK: 1, refWidthPct: 1, maxHalfPct: 1 };
    var DEADBAND = opt.deadband || { tradeK: 1.0, quoteK: 1.0, refWidthPct: 0.0025 };
    var cur = {}; KEYS.forEach(function (k) { cur[k] = PRODUCTION[k]; });
    var calibrations = [];
    var pending = [], schedule = [], log = [];
    for (var t = start; t < nDays; t++) {
      pending = pending.filter(function (pc) { if (pc.effective <= t) { cur[pc.key] = pc.value; log.push({ day: t, key: pc.key, value: pc.value }); return false; } return true; });
      if ((t - start) % every === 0) {
        var calib = []; for (var dd = Math.max(0, t - win); dd < t; dd++) calib = calib.concat(byDay[dd]);
        var c = calibrate(calib, alpha, cur);
        calibrations.push({ day: t, result: c });
        KEYS.forEach(function (key) {
          var v = c[key]; if (v === cur[key]) return;
          // deadband: small reductions are not worth a circular; increases always go out (coverage)
          if (v < cur[key] && cur[key] - v < (DEADBAND[key] || 0) - 1e-12) return;
          // the circular: reductions to k, the Reference width or the Maximum Half-Width need 1 business day of notice, other changes 5
          var lag = (v < cur[key] && DECREASE_1DAY[key]) ? 1 : 5;
          pending = pending.filter(function (pc) { return pc.key !== key; });
          pending.push({ key: key, value: v, announced: t, effective: t + lag });
        });
      }
      var snap = {}; KEYS.forEach(function (k) { snap[k] = cur[k]; }); schedule[t] = snap;
    }
    var fin = {}; KEYS.forEach(function (k) { fin[k] = cur[k]; });
    return { schedule: schedule, log: log, start: start, alpha: alpha, window: win, final: fin, calibrations: calibrations, pending: pending };
  }

  function summarize(rows) {
    var n = rows.length, miss = 0, half = 0, po = 0, dis = 0;
    rows.forEach(function (r) { if (!r.inside) { miss++; dis += r.dislocBps; po += r.pricedOut; } half += r.halfBps; });
    return { n: n, misses: miss, missRate: n ? miss / n : 0, meanHalfBps: n ? half / n : 0, pricedOut: po, meanDislocBps: miss ? dis / miss : 0 };
  }

  // Full analysis used by the page and the report script.
  function analyze(data, opt) {
    opt = opt || {};
    var wf = walkForward(data, opt), start = wf.start;
    var evalSessions = data.sessions.filter(function (x) { return x.day >= start; });
    var prod = [], cal = [];
    evalSessions.forEach(function (x) {
      var a = evaluateSession(x, PRODUCTION);
      var b = evaluateSession(x, withParams(wf.schedule[x.day]));
      a.x = x; b.x = x; prod.push(a); cal.push(b);
    });
    var by = function (rows, m) { return rows.filter(function (r) { return !m || r.method === m; }); };
    var methods = {};
    METHODS.forEach(function (m) { methods[m] = { production: summarize(by(prod, m)), calibrated: summarize(by(cal, m)) }; });
    var symbols = data.symbols.map(function (s) {
      var f = function (rows) { return rows.filter(function (r) { return r.x.sym === s.sym; }); };
      var pr = f(prod), cr = f(cal), mix = { trade: 0, quote: 0, reference: 0 };
      pr.forEach(function (r) { mix[r.method]++; });
      return { sym: s.sym, kind: s.kind, mix: mix, production: summarize(pr), calibrated: summarize(cr) };
    });
    return {
      walk: wf, evalDays: data.dates.slice(start), production: summarize(prod), calibrated: summarize(cal),
      methods: methods, symbols: symbols, prodRows: prod, calRows: cal, final: wf.final
    };
  }

  // Miss rate and mean half-width for a sweep of one method's parameter (frontier chart).
  function sweep(data, method, values, start) {
    var key = paramKey(method);
    var xs = data.sessions.filter(function (x) {
      var b = x._basis || (x._basis = bandBasis(x.ev, PRODUCTION));
      return x.day >= (start == null ? 30 : start) && b.method === method;
    });
    return values.map(function (v) {
      var o = {}; o[key] = v; var p = withParams(o), miss = 0, half = 0;
      xs.forEach(function (x) { var b = x._basis, band = bandFrom(b, p); if (x.pu < band.lower || x.pu > band.upper) miss++; half += band.half / b.mid * 1e4; });
      return { value: v, missRate: xs.length ? miss / xs.length : 0, meanHalfBps: xs.length ? half / xs.length : 0, n: xs.length };
    });
  }

  // Public Auction Viewer snapshot: auctions with executions whose official price printed outside the final band.
  function snapshotCheck(snap) {
    var rows = snap.rows.map(function (r) {
      var out = r.executed > 0 && (r.officialPrice < r.lower || r.officialPrice > r.upper);
      var gap = r.officialPrice < r.lower ? r.lower - r.officialPrice : r.officialPrice > r.upper ? r.officialPrice - r.upper : 0;
      var halfPct = (r.upper - r.lower) / 2 / ((r.upper + r.lower) / 2) * 100;
      return { symbol: r.symbol, auction: r.auction, lower: r.lower, upper: r.upper, official: r.officialPrice, executed: r.executed, outside: out, gap: +gap.toFixed(2), halfPct: halfPct };
    });
    var executed = rows.filter(function (r) { return r.executed > 0; });
    return { rows: rows, executed: executed.length, outside: rows.filter(function (r) { return r.outside; }) };
  }

  return {
    makeRng: makeRng, median: median, mad: mad, conformalQuantile: conformalQuantile,
    PRODUCTION: PRODUCTION, RANGES: RANGES, withParams: withParams,
    bandBasis: bandBasis, bandFrom: bandFrom, halfWidth: halfWidth, score: score,
    clear: clear, applyBand: applyBand, pricedOut: pricedOut,
    SYMBOLS: SYMBOLS, sessionDates: sessionDates, EVENT_DAYS: EVENT_DAYS, generate: generate,
    evaluateSession: evaluateSession, calibrate: calibrate, calibrateMethods: calibrateMethods, GRID: GRID, walkForward: walkForward, summarize: summarize,
    analyze: analyze, sweep: sweep, snapshotCheck: snapshotCheck, METHODS: METHODS
  };
});
