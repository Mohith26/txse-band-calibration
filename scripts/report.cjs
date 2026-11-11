// Prints every number the page shows (same core, same seed). Usage: node scripts/report.cjs [alpha]
const path = require('path'), fs = require('fs');
const B = require(path.join(__dirname, '..', 'core', 'bands.js'));
const alpha = process.argv[2] ? +process.argv[2] : 0.02;
const data = B.generate(20261110);
const A = B.analyze(data, { alpha });
const pct = (x) => (x * 100).toFixed(1) + '%';
const f = (s) => `${s.n} auctions, ${s.misses} outside (${pct(s.missRate)}), mean half-width ${s.meanHalfBps.toFixed(1)} bps, late shares priced out ${s.pricedOut.toLocaleString('en-US')}, mean dislocation when outside ${s.meanDislocBps.toFixed(1)} bps`;
console.log(`Target miss rate ${pct(alpha)}; evaluation ${A.evalDays[0]} to ${A.evalDays[A.evalDays.length - 1]} (${A.evalDays.length} sessions x 22 symbols)`);
console.log('ALL production :', f(A.production));
console.log('ALL calibrated :', f(A.calibrated));
for (const m of B.METHODS) { console.log(m.padEnd(9), 'production :', f(A.methods[m].production)); console.log(m.padEnd(9), 'calibrated :', f(A.methods[m].calibrated)); }
console.log('Values in effect after the last session:', JSON.stringify(A.final));
console.log('Calibrations:'); A.walk.calibrations.forEach((c) => console.log('  day', c.day, data.dates[c.day], JSON.stringify({ tradeK: c.result.tradeK, quoteK: c.result.quoteK, refWidthPct: c.result.refWidthPct, mpvFloor: c.result.mpvFloor, bpsFloor: c.result.bpsFloor, maxHalfPct: c.result.maxHalfPct, feasible: c.result.feasible })));
console.log('Effective changes:'); A.walk.log.forEach((e) => console.log('  ', data.dates[e.day], e.key, e.value));
console.log('Per symbol (production -> calibrated miss rate, half-width bps):');
A.symbols.forEach((s) => console.log('  ', s.sym.padEnd(9), pct(s.production.missRate), '->', pct(s.calibrated.missRate), '|', s.production.meanHalfBps.toFixed(0), '->', s.calibrated.meanHalfBps.toFixed(0)));
const snap = JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'auction-viewer-2026-11-10.json')));
const c = B.snapshotCheck(snap);
console.log(`Public Auction Viewer, Nov 10: ${c.outside.length} of ${c.executed} executed auctions printed outside the final band:`);
c.outside.forEach((r) => console.log('  ', r.symbol, r.auction, r.official, `[${r.lower}, ${r.upper}]`, 'gap', r.gap));
