const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const B = require(path.join(__dirname, '..', 'core', 'bands.js'));

const T = (d) => Math.round(d * 100); // dollars -> ticks

test('Reference Price Method reproduces published bands (FIFT, Nov 10 public Auction Viewer)', () => {
  // FIFT had no trades and no quotes in the window, so the bands are the reference price +/- 1.25%.
  const close = B.bandFrom(B.bandBasis({ trades: [], quotes: [], lastSale: T(26.33), priorClose: T(26.22) }, B.PRODUCTION), B.PRODUCTION);
  assert.equal(close.method, 'reference');
  assert.deepEqual([close.lower, close.upper], [T(26.00), T(26.66)]);
  const open = B.bandFrom(B.bandBasis({ trades: [], quotes: [], lastSale: null, priorClose: T(26.22) }, B.PRODUCTION), B.PRODUCTION);
  assert.deepEqual([open.lower, open.upper], [T(25.89), T(26.55)]);
});

test('Trade Method: median +/- k*MAD with the MPV floor reproduces ET close band (19.34 x 19.44)', () => {
  // 60 prints around 19.39 with a one-tick bounce: MAD is 1 tick, 5 x MAD = 5 ticks = the MPV floor.
  const trades = []; for (let i = 0; i < 60; i++) trades.push({ px: T(19.39) + (i % 3) - 1, sz: 100 });
  const b = B.bandBasis({ trades, quotes: [], priorClose: T(19.4) }, B.PRODUCTION);
  assert.equal(b.method, 'trade');
  const band = B.bandFrom(b, B.PRODUCTION);
  assert.deepEqual([band.lower, band.upper], [T(19.34), T(19.44)]);
});

test('Quality gates: corrected/late trades excluded; crossed, locked, one-sided and wide quotes excluded', () => {
  const trades = []; for (let i = 0; i < 49; i++) trades.push({ px: 5000, sz: 100 });
  trades.push({ px: 5000, sz: 100, flag: 'corrected' });
  const quotes = [];
  for (let i = 0; i < 50; i++) quotes.push({ bid: 4999, ask: 5001 });
  quotes.push({ bid: 5001, ask: 5000 }, { bid: 5000, ask: 5000 }, { bid: 0, ask: 5001 }, { bid: 4000, ask: 6000 });
  const b = B.bandBasis({ trades, quotes, priorClose: 5000 }, B.PRODUCTION);
  assert.equal(b.method, 'quote');   // only 49 eligible trades < 50
  assert.equal(b.n, 50);             // the four bad quotes are gated out
  quotes.length = 49;
  assert.equal(B.bandBasis({ trades, quotes, priorClose: 5000 }, B.PRODUCTION).method, 'reference');
});

// Order book from SR-TXSE-2026-006, Example 2 ("Participation Bands Impact Closing Auction Price").
const example2 = () => [
  { side: 'S', qty: 4000, limit: null, late: false },        // A  MOC
  { side: 'B', qty: 2000, limit: T(50.10), late: false },    // B  LOC
  { side: 'B', qty: 2000, limit: T(50.00), late: false },    // C  displayed limit
  { side: 'S', qty: 4000, limit: T(50.10), late: false },    // D  displayed limit
  { side: 'B', qty: 5000, limit: T(50.10), late: true },     // E  LOC.L
  { side: 'S', qty: 10000, limit: T(49.00), late: true },    // F  LOC.L
  { side: 'B', qty: 1000, limit: T(49.00), late: true }      // G  LOC.L
];

test("Auction price determination matches TXSE's filing examples", () => {
  // Example 1 (Auction Only Price before 3:58, orders A and B only): 2,000 shares at $50.10, Offset Side Sell.
  const ex1 = B.clear([{ side: 'S', qty: 4000, limit: null }, { side: 'B', qty: 2000, limit: T(50.10) }], T(50.10));
  assert.equal(ex1.price, T(50.10)); assert.equal(ex1.matched, 2000); assert.equal(ex1.excess, 'S');
  // Example 2 without bands: 10,000 shares would execute at $49.00.
  const u = B.clear(example2(), T(50.10));
  assert.equal(u.price, T(49.00)); assert.equal(u.matched, 10000);
  // With the $49.80 x $50.20 band, F is adjusted to $49.80 and the auction prints 9,000 at $49.80.
  const banded = B.applyBand(example2(), T(49.80), T(50.20));
  assert.equal(banded[5].limit, T(49.80)); assert.equal(banded[6].limit, T(49.00)); // G is not adjusted
  const c = B.clear(banded, T(50.10));
  assert.equal(c.price, T(49.80)); assert.equal(c.matched, 9000);
  // F's 10,000 shares were marketable at $49.00 and are priced out by the band.
  assert.equal(B.pricedOut(example2(), banded, T(49.00)), 10000);
});

test('score is exact: price inside band(k) <=> score <= k', () => {
  const data = B.generate(7);
  let checked = 0, bad = 0;
  for (const x of data.sessions) {
    const b = B.bandBasis(x.ev, B.PRODUCTION);
    const s = B.score(b, x.pu, B.PRODUCTION);
    for (const k of [1, 2.5, 5, 7.3, 10]) {
      const p = B.withParams(b.method === 'reference' ? { refWidthPct: Math.min(0.025, k / 400) } : { tradeK: k, quoteK: k });
      const band = B.bandFrom(b, p);
      const inside = x.pu >= band.lower && x.pu <= band.upper;
      const v = b.method === 'reference' ? p.refWidthPct : k;
      // exact ties at a band edge are the only way the two can disagree
      if (inside !== (s <= v + 1e-12) && Math.abs(s - v) > 1e-9) bad++;
      checked++;
    }
  }
  assert.ok(checked > 5000);
  assert.equal(bad, 0);
});

test('split conformal hits the target miss rate on exchangeable scores', () => {
  const rng = B.makeRng(42); let miss = 0, tot = 0;
  for (let rep = 0; rep < 200; rep++) {
    const s = []; for (let i = 0; i < 300; i++) s.push(Math.abs(rng.t(3)) * 3);
    const q = B.conformalQuantile(s.slice(0, 150), 0.05);
    s.slice(150).forEach((z) => { tot++; if (z > q) miss++; });
  }
  const rate = miss / tot;
  assert.ok(rate <= 0.05 + 0.006 && rate >= 0.03, 'miss rate ' + rate);
  assert.equal(B.conformalQuantile([1, 2, 3], 0.01), Infinity); // too few points for a 99% guarantee
});

test('generator is deterministic and uses the real TXSE symbol list', () => {
  const a = B.generate(123), b = B.generate(123);
  assert.equal(a.sessions.length, 60 * 22);
  assert.deepEqual(a.sessions.slice(0, 50).map((x) => x.pu), b.sessions.slice(0, 50).map((x) => x.pu));
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'auction-viewer-2026-11-10.json')));
  const live = new Set(snap.rows.map((r) => r.symbol));
  B.SYMBOLS.forEach((s) => assert.ok(live.has(s.sym), s.sym));
});

test('walk-forward has no look-ahead and respects notice periods', () => {
  const data = B.generate(20261110);
  const wf = B.walkForward(data, { alpha: 0.02 });
  // corrupt every session from day 45 on: schedules for days < 45 must not change
  const data2 = B.generate(20261110);
  data2.sessions.forEach((x) => { if (x.day >= 45) x.pu += 500; });
  const wf2 = B.walkForward(data2, { alpha: 0.02 });
  for (let t = 30; t < 45; t++) assert.deepEqual(wf.schedule[t], wf2.schedule[t]);
  // every change lands 1 business day after a calibration day if it is a reduction of k / width / max half-width, otherwise 5
  const calDays = new Set(wf.calibrations.map((c) => c.day));
  wf.log.forEach((e) => {
    const prev = wf.schedule[e.day - 1] ? wf.schedule[e.day - 1][e.key] : B.PRODUCTION[e.key];
    const oneDay = ['tradeK', 'quoteK', 'refWidthPct', 'maxHalfPct'].includes(e.key) && e.value < prev;
    assert.ok(calDays.has(e.day - (oneDay ? 1 : 5)), JSON.stringify(e));
  });
  // calibrated values stay inside the rule's permissible ranges
  wf.calibrations.forEach((c) => {
    for (const k of ['tradeK', 'quoteK', 'refWidthPct', 'mpvFloor', 'bpsFloor', 'maxHalfPct']) {
      assert.ok(c.result[k] >= B.RANGES[k][0] - 1e-12 && c.result[k] <= B.RANGES[k][1] + 1e-12, k);
    }
  });
});

test('analysis is internally consistent and calibration lowers misses at the 2% target', () => {
  const data = B.generate(20261110);
  const A = B.analyze(data, { alpha: 0.02 });
  const sum = (key, field) => B.METHODS.reduce((s, m) => s + A.methods[m][key][field], 0);
  assert.equal(sum('production', 'n'), A.production.n);
  assert.equal(sum('production', 'misses'), A.production.misses);
  assert.equal(sum('calibrated', 'misses'), A.calibrated.misses);
  assert.equal(sum('calibrated', 'pricedOut'), A.calibrated.pricedOut);
  assert.equal(A.symbols.reduce((s, x) => s + x.production.misses, 0), A.production.misses);
  assert.ok(A.calibrated.missRate < A.production.missRate);
  // a session inside the band has no priced-out shares and no dislocation
  A.prodRows.forEach((r) => { if (r.inside) { assert.equal(r.pricedOut, 0); assert.equal(r.dislocBps, 0); } });
});

test('public snapshot check finds the auctions that printed outside the final band', () => {
  const snap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'auction-viewer-2026-11-10.json')));
  const c = B.snapshotCheck(snap);
  assert.equal(c.executed, 30);
  assert.deepEqual(c.outside.map((r) => r.symbol + ' ' + r.auction).sort(), ['DDS Open', 'IBOC Close', 'SUNC Open', 'TXCP Close']);
});
