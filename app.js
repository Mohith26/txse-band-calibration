/* Band Calibration tab. Every number on the page is computed here from core/bands.js and the seeded data. */
(function () {
  'use strict';
  var B = window.Bands, SEED = 20261110;
  var qs = new URLSearchParams(location.search);
  var state = {
    alpha: [0.01, 0.02, 0.05].indexOf(+qs.get('target') / 100) >= 0 ? +qs.get('target') / 100 : 0.02,
    q: '', replay: null
  };
  var PIN_KEY = 'auction-viewer-public.pinnedSymbols';
  var pinned = (function () { try { return JSON.parse(localStorage.getItem(PIN_KEY)) || []; } catch (e) { return []; } })();
  var t0 = performance.now();
  var data = B.generate(SEED), A = null, cache = {};
  var METHOD_NAME = { trade: 'Trade Method', quote: 'Quote Method', reference: 'Reference Price' };
  var COLORS = { trade: '#4a9cb8', quote: '#7ec8e3', reference: '#b0c4d8' };
  var $ = function (id) { return document.getElementById(id); };

  // ------------------------------------------------------------ formatting
  var DOW = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'], MON = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  function dlong(iso) { var d = new Date(iso + 'T12:00:00Z'); return DOW[d.getUTCDay()] + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCDate() + ', ' + d.getUTCFullYear(); }
  function dshort(iso) { var d = new Date(iso + 'T12:00:00Z'); return DOW[d.getUTCDay()] + ' ' + MON[d.getUTCMonth()] + ' ' + d.getUTCDate(); }
  function num(n) { return String(Math.round(n)).replace(/\B(?=(\d{3})+(?!\d))/g, ','); }
  function pct(x, d) { return (x * 100).toFixed(d == null ? 1 : d) + '%'; }
  function usd(t) { return (t / 100).toFixed(2); }
  function kval(key, v) { return key === 'refWidthPct' ? (v * 100).toFixed(2) + '%' : key === 'maxHalfPct' ? (v * 100).toFixed(2) + '%' : key === 'mpvFloor' ? v + ' × MPV' : key === 'bpsFloor' ? v + ' bps' : v.toFixed(1); }
  var KEYNAME = { tradeK: 'Trade Method k', quoteK: 'Quote Method k', refWidthPct: 'Reference Price Width', mpvFloor: 'MPV Floor', bpsFloor: 'Basis Point Floor', maxHalfPct: 'Maximum Half-Width' };
  function esc(s) { return String(s).replace(/[&<>"]/g, function (c) { return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;' }[c]; }); }

  function compute() {
    var key = String(state.alpha);
    if (!cache[key]) cache[key] = B.analyze(data, { alpha: state.alpha });
    A = cache[key];
  }

  // ------------------------------------------------------------ tiles
  function tile(label, from, to, note, cls) {
    return '<div class="tile"><div class="tile-l">' + label + '</div><div class="tile-v"><span class="from">' + from + '</span><span class="arrow">→</span><span class="to ' + (cls || '') + '">' + to + '</span></div><div class="tile-n">' + note + '</div></div>';
  }
  function renderTiles() {
    var p = A.production, c = A.calibrated;
    var cut = 1 - c.pricedOut / Math.max(1, p.pricedOut);
    var w = c.meanHalfBps / p.meanHalfBps - 1;
    $('tiles').innerHTML =
      tile('Auctions clearing outside the final band', pct(p.missRate), pct(c.missRate), num(p.misses) + ' → ' + num(c.misses) + ' of ' + num(p.n) + ' closing auctions · target ' + pct(state.alpha), c.missRate <= p.missRate ? 'good' : 'warn') +
      tile('Mean band half-width', p.meanHalfBps.toFixed(1) + ' bps', c.meanHalfBps.toFixed(1) + ' bps', (w <= 0 ? Math.abs(w * 100).toFixed(0) + '% narrower' : (w * 100).toFixed(0) + '% wider') + ' on average across all methods') +
      tile('Late shares priced out by the band', num(p.pricedOut), num(c.pricedOut), (cut >= 0 ? (cut * 100).toFixed(0) + '% fewer' : Math.abs(cut * 100).toFixed(0) + '% more') + ' LOC.L shares that were marketable at the unconstrained price', cut >= 0 ? 'good' : 'warn') +
      tile('Outside rate by method (%)', ['trade', 'quote', 'reference'].map(function (m) { return (A.methods[m].production.missRate * 100).toFixed(1); }).join('/'),
        ['trade', 'quote', 'reference'].map(function (m) { return (A.methods[m].calibrated.missRate * 100).toFixed(1); }).join(' / '),
        'Trade / Quote / Reference: one k = 5.0 gives uneven protection', 'sm');
  }

  // ------------------------------------------------------------ parameters by method
  function renderMethods() {
    var fin = A.final, P = B.PRODUCTION, html = '';
    ['trade', 'quote', 'reference'].forEach(function (m) {
      var key = m === 'trade' ? 'tradeK' : m === 'quote' ? 'quoteK' : 'refWidthPct';
      [['Production', P, A.methods[m].production], ['Calibrated', fin, A.methods[m].calibrated]].forEach(function (r, j) {
        var s = r[2], cal = j === 1;
        html += '<tr class="' + (j === 0 ? 'up' : 'calrow') + '">' +
          (j === 0 ? '<td class="sym" rowspan="2">' + METHOD_NAME[m] + '</td>' : '') +
          '<td class="' + (cal ? 'cal' : 'lbl') + '">' + r[0] + '</td>' +
          '<td class="n">' + kval(key, r[1][key]) + '</td>' +
          '<td class="n">' + r[1].mpvFloor + ' × MPV</td><td class="n">' + r[1].bpsFloor + ' bps</td><td class="n">' + (r[1].maxHalfPct * 100).toFixed(2) + '%</td>' +
          (j === 0 ? '<td class="n" rowspan="2">' + num(s.n) + '</td>' : '') +
          '<td class="n">' + num(s.misses) + '</td>' +
          '<td class="n' + (s.missRate > state.alpha * 1.5 ? ' miss-hi' : '') + '">' + pct(s.missRate) + '</td>' +
          '<td class="n">' + s.meanHalfBps.toFixed(1) + '</td>' +
          '<td class="n">' + num(s.pricedOut) + '</td>' +
          '<td class="n end">' + (s.misses ? s.meanDislocBps.toFixed(1) : '-') + '</td></tr>';
      });
    });
    $('methodBody').innerHTML = html;
    $('paramSub').textContent = 'Calibrated values in effect after ' + dshort(data.dates[data.dates.length - 1]) + ' · ' + A.evalDays.length + ' sessions, ' + dshort(A.evalDays[0]) + ' to ' + dshort(A.evalDays[A.evalDays.length - 1]);
  }

  // ------------------------------------------------------------ svg helpers
  function el(tag, attrs, text) {
    var e = document.createElementNS('http://www.w3.org/2000/svg', tag);
    for (var k in attrs) e.setAttribute(k, attrs[k]);
    if (text != null) e.textContent = text;
    return e;
  }
  var tip = $('tip');
  function showTip(evt, html) { tip.innerHTML = html; tip.hidden = false; tip.style.left = (evt.clientX + 14) + 'px'; tip.style.top = (evt.clientY - 10) + 'px'; }
  function hideTip() { tip.hidden = true; }

  // ------------------------------------------------------------ frontier
  var KS = []; for (var kk = 1; kk <= 10.0001; kk += 0.25) KS.push(+kk.toFixed(2));
  var WS = []; for (var ww = 0.005; ww <= 0.02501; ww += 0.00125) WS.push(+ww.toFixed(5));
  var sweeps = null;
  function renderFrontier() {
    if (!sweeps) sweeps = { trade: B.sweep(data, 'trade', KS), quote: B.sweep(data, 'quote', KS), reference: B.sweep(data, 'reference', WS) };
    var svg = $('frontier'); svg.innerHTML = '';
    var L = 46, R = 548, T = 12, Bm = 262, xmax = 140, ymax = 0.45;
    var X = function (v) { return L + (R - L) * Math.min(v, xmax) / xmax; }, Y = function (v) { return Bm - (Bm - T) * Math.min(v, ymax) / ymax; };
    for (var gx = 0; gx <= xmax; gx += 20) { svg.appendChild(el('line', { x1: X(gx), x2: X(gx), y1: T, y2: Bm, stroke: 'rgba(91,163,200,.14)' })); svg.appendChild(el('text', { x: X(gx), y: Bm + 14, 'text-anchor': 'middle', class: 'num' }, gx)); }
    for (var gy = 0; gy <= ymax + 1e-9; gy += 0.05) { svg.appendChild(el('line', { x1: L, x2: R, y1: Y(gy), y2: Y(gy), stroke: gy === 0 ? 'rgba(91,163,200,.45)' : 'rgba(91,163,200,.14)' })); svg.appendChild(el('text', { x: L - 6, y: Y(gy) + 3, 'text-anchor': 'end', class: 'num' }, Math.round(gy * 100) + '%')); }
    svg.appendChild(el('text', { x: (L + R) / 2, y: 292, 'text-anchor': 'middle' }, 'Mean half-width (bps)'));
    svg.appendChild(el('text', { x: 12, y: (T + Bm) / 2, 'text-anchor': 'middle', transform: 'rotate(-90 12 ' + (T + Bm) / 2 + ')' }, 'Outside band'));
    svg.appendChild(el('line', { x1: L, x2: R, y1: Y(state.alpha), y2: Y(state.alpha), stroke: '#66bb6a', 'stroke-dasharray': '4 4', 'stroke-width': 1 }));
    svg.appendChild(el('text', { x: R - 2, y: Y(state.alpha) - 4, 'text-anchor': 'end', fill: '#66bb6a' }, 'target ' + pct(state.alpha, 0)));
    ['trade', 'quote', 'reference'].forEach(function (m) {
      var pts = sweeps[m], d = pts.map(function (p, i) { return (i ? 'L' : 'M') + X(p.meanHalfBps).toFixed(1) + ' ' + Y(p.missRate).toFixed(1); }).join(' ');
      svg.appendChild(el('path', { d: d, fill: 'none', stroke: COLORS[m], 'stroke-width': 1.6 }));
      pts.forEach(function (p) {
        var c = el('circle', { cx: X(p.meanHalfBps), cy: Y(p.missRate), r: 5, fill: 'transparent' });
        c.addEventListener('mousemove', function (e) { showTip(e, METHOD_NAME[m] + ' · ' + (m === 'reference' ? 'width <span class="n">' + (p.value * 100).toFixed(3) + '%</span>' : 'k <span class="n">' + p.value.toFixed(2) + '</span>') + '<br>outside <span class="n">' + pct(p.missRate) + '</span> · half-width <span class="n">' + p.meanHalfBps.toFixed(1) + ' bps</span>'); });
        c.addEventListener('mouseleave', hideTip);
        svg.appendChild(c);
      });
      var pr = A.methods[m].production, ca = A.methods[m].calibrated;
      svg.appendChild(el('circle', { cx: X(pr.meanHalfBps), cy: Y(pr.missRate), r: 4.5, fill: '#0b1d30', stroke: '#ffb74d', 'stroke-width': 1.8 }));
      var cx = X(ca.meanHalfBps), cy = Y(ca.missRate);
      svg.appendChild(el('path', { d: 'M' + cx + ' ' + (cy - 5.5) + ' L' + (cx + 5.5) + ' ' + cy + ' L' + cx + ' ' + (cy + 5.5) + ' L' + (cx - 5.5) + ' ' + cy + ' Z', fill: COLORS[m], stroke: '#0b1d30', 'stroke-width': 1 }));
      [[pr, 'production'], [ca, 'calibrated']].forEach(function (z) {
        var hit = el('circle', { cx: X(z[0].meanHalfBps), cy: Y(z[0].missRate), r: 8, fill: 'transparent' });
        hit.addEventListener('mousemove', function (e) { showTip(e, METHOD_NAME[m] + ' · ' + z[1] + '<br>outside <span class="n">' + pct(z[0].missRate) + '</span> (' + z[0].misses + ' of ' + z[0].n + ') · half-width <span class="n">' + z[0].meanHalfBps.toFixed(1) + ' bps</span>'); });
        hit.addEventListener('mouseleave', hideTip);
        svg.appendChild(hit);
      });
    });
    $('frontierSub').textContent = 'curves sweep k (Reference: width) at production floors';
    $('frontierLegend').innerHTML = ['trade', 'quote', 'reference'].map(function (m) { return '<span><i style="border-color:' + COLORS[m] + '"></i>' + METHOD_NAME[m] + '</span>'; }).join('') +
      '<span><b style="border:2px solid #ffb74d;background:transparent;width:6px;height:6px"></b>Production</span><span><b style="background:#7ec8e3;border-radius:1px;transform:rotate(45deg)"></b>Calibrated</span>';
  }

  // ------------------------------------------------------------ replay
  function replayOptions() {
    var rows = A.prodRows.map(function (r, i) { return { r: r, c: A.calRows[i], i: i }; }).filter(function (z) { return !z.r.inside; });
    rows.sort(function (a, b) { return (b.c.inside - a.c.inside) || (b.r.pricedOut - a.r.pricedOut); });
    return rows;
  }
  function renderReplaySelect() {
    var opts = replayOptions(), sel = $('replaySel');
    sel.innerHTML = opts.map(function (z) {
      return '<option value="' + z.i + '">' + esc(z.r.x.sym) + ' · ' + dshort(z.r.x.date) + ' · ' + METHOD_NAME[z.r.method] + (z.c.inside ? ' · fixed' : ' · still outside') + '</option>';
    }).join('');
    if (state.replay == null || !opts.some(function (z) { return z.i === state.replay; })) state.replay = opts.length ? opts[0].i : 0;
    sel.value = String(state.replay);
  }
  function renderReplay() {
    var r = A.prodRows[state.replay], c = A.calRows[state.replay], x = r.x, svg = $('replay');
    svg.innerHTML = '';
    var trades = x.ev.trades.filter(function (t) { return !t.flag; });
    var mids = x.ev.quotes.filter(function (q) { return q.bid > 0 && q.ask > q.bid; }).map(function (q) { return { t: q.t, px: (q.bid + q.ask) / 2 }; });
    var pts = r.method === 'trade' ? trades : r.method === 'quote' ? mids : trades.concat(mids);
    var ys = pts.map(function (p) { return p.px; }).concat([r.lower, r.upper, c.lower, c.upper, x.pu, r.pb]);
    var lo = Math.min.apply(null, ys), hi = Math.max.apply(null, ys), pad = Math.max(2, (hi - lo) * 0.12); lo -= pad; hi += pad;
    var L = 52, R = 500, T = 12, Bm = 262;
    var X = function (t) { return L + (R - L) * (t + 300) / 330; }, Y = function (v) { return Bm - (Bm - T) * (v - lo) / (hi - lo); };
    var step = Math.max(1, Math.ceil((hi - lo) / 6));
    for (var v = Math.ceil(lo / step) * step; v <= hi; v += step) { svg.appendChild(el('line', { x1: L, x2: R, y1: Y(v), y2: Y(v), stroke: 'rgba(91,163,200,.14)' })); svg.appendChild(el('text', { x: L - 6, y: Y(v) + 3, 'text-anchor': 'end', class: 'num' }, usd(v))); }
    [[-300, '3:55'], [-240, '3:56'], [-180, '3:57'], [-120, '3:58'], [-60, '3:59'], [0, '4:00']].forEach(function (g) {
      svg.appendChild(el('line', { x1: X(g[0]), x2: X(g[0]), y1: T, y2: Bm, stroke: g[0] === -120 || g[0] === 0 ? 'rgba(91,163,200,.4)' : 'rgba(91,163,200,.14)' }));
      svg.appendChild(el('text', { x: X(g[0]), y: Bm + 14, 'text-anchor': 'middle', class: 'num' }, g[1]));
    });
    svg.appendChild(el('rect', { x: X(-120), y: T, width: X(0) - X(-120), height: Bm - T, fill: 'rgba(126,200,227,.05)' }));
    svg.appendChild(el('text', { x: X(-60), y: T + 11, 'text-anchor': 'middle' }, 'Band Window'));
    pts.forEach(function (p) { svg.appendChild(el('circle', { cx: X(p.t), cy: Y(p.px), r: 1.7, fill: r.method === 'quote' ? '#7ec8e3' : '#4a9cb8', opacity: 0.75 })); });
    svg.appendChild(el('line', { x1: X(-300), x2: X(0), y1: Y(r.mid), y2: Y(r.mid), stroke: '#6b8299', 'stroke-dasharray': '2 3' }));
    function band(b, color, dash, label) {
      [b.lower, b.upper].forEach(function (v) { svg.appendChild(el('line', { x1: X(-120), x2: X(18), y1: Y(v), y2: Y(v), stroke: color, 'stroke-width': 1.6, 'stroke-dasharray': dash || '' })); });
      svg.appendChild(el('text', { x: X(18) + 4, y: Y(b.upper) + 3, fill: color, class: 'num' }, usd(b.upper)));
      svg.appendChild(el('text', { x: X(18) + 4, y: Y(b.lower) + 3, fill: color, class: 'num' }, usd(b.lower)));
    }
    band(r, '#ffb74d', '5 3'); band(c, '#7ec8e3');
    svg.appendChild(el('circle', { cx: X(6), cy: Y(x.pu), r: 4.5, fill: '#f0f4f8' }));
    svg.appendChild(el('circle', { cx: X(12), cy: Y(r.pb), r: 4, fill: 'none', stroke: '#ffb74d', 'stroke-width': 1.8 }));
    $('replayLegend').innerHTML =
      '<span><b style="background:' + (r.method === 'quote' ? '#7ec8e3' : '#4a9cb8') + '"></b>' + (r.method === 'quote' ? 'NBBO midpoints' : 'Eligible trades') + ' (' + METHOD_NAME[r.method] + ')</span>' +
      '<span><i class="dash" style="border-color:#ffb74d"></i>Production ' + usd(r.lower) + ' × ' + usd(r.upper) + '</span>' +
      '<span><i style="border-color:#7ec8e3"></i>Calibrated ' + usd(c.lower) + ' × ' + usd(c.upper) + '</span>' +
      '<span><b style="background:#f0f4f8"></b>Unconstrained ' + usd(x.pu) + '</span>' +
      '<span><b style="border:2px solid #ffb74d;background:transparent;width:6px;height:6px"></b>Prints with production band ' + usd(r.pb) + ' · ' + num(r.pricedOut) + ' late shares priced out</span>';
  }

  // ------------------------------------------------------------ by symbol
  function worst(sym) {
    var best = null;
    A.prodRows.forEach(function (r, i) { if (r.x.sym === sym && !r.inside && (!best || r.pricedOut > A.prodRows[best].pricedOut)) best = i; });
    return best;
  }
  function renderSymbols() {
    var q = state.q.trim().toUpperCase();
    var syms = A.symbols.filter(function (s) { return !q || s.sym.indexOf(q) !== -1; });
    syms.sort(function (a, b) { var pa = pinned.indexOf(a.sym) !== -1, pb = pinned.indexOf(b.sym) !== -1; return (pb - pa); });
    var html = '';
    syms.forEach(function (s) {
      var tot = s.mix.trade + s.mix.quote + s.mix.reference, wi = worst(s.sym), isPin = pinned.indexOf(s.sym) !== -1;
      [['Production', s.production], ['Calibrated', s.calibrated]].forEach(function (r, j) {
        html += '<tr class="' + (j === 0 ? 'up' : 'calrow') + '">';
        if (j === 0) {
          html += '<td class="pin-cell" rowspan="2"><button class="pin-btn' + (isPin ? ' pinned' : '') + '" data-symbol="' + s.sym + '" aria-label="pin ' + s.sym + ' to top">★</button></td>' +
            '<td class="sym" rowspan="2">' + s.sym + '</td><td rowspan="2">' + s.kind + '</td>' +
            '<td rowspan="2"><div class="mix-txt">' + s.mix.trade + ' / ' + s.mix.quote + ' / ' + s.mix.reference + '</div><div class="mix"><span class="t" style="width:' + (s.mix.trade / tot * 100) + '%"></span><span class="q" style="width:' + (s.mix.quote / tot * 100) + '%"></span><span class="r" style="width:' + (s.mix.reference / tot * 100) + '%"></span></div></td>';
        }
        html += '<td class="' + (j ? 'cal' : 'lbl') + '">' + r[0] + '</td><td class="n">' + r[1].misses + ' of ' + r[1].n + '</td>' +
          '<td class="n' + (r[1].missRate > state.alpha * 1.5 ? ' miss-hi' : '') + '">' + pct(r[1].missRate) + '</td><td class="n">' + r[1].meanHalfBps.toFixed(1) + '</td><td class="n">' + num(r[1].pricedOut) + '</td>';
        if (j === 0) html += '<td rowspan="2" class="end' + (wi != null ? ' click" data-i="' + wi + '"' : '"') + '>' + (wi != null ? dshort(A.prodRows[wi].x.date) + ' · replay' : '-') + '</td>';
        html += '</tr>';
      });
    });
    $('symBody').innerHTML = html;
    var empty = $('empty'); empty.hidden = syms.length > 0; empty.textContent = 'No symbol matches “' + state.q + '”.';
  }

  // ------------------------------------------------------------ circular log and public snapshot
  function renderLog() {
    var prev = {}; Object.keys(B.PRODUCTION).forEach(function (k) { prev[k] = B.PRODUCTION[k]; });
    var rows = A.walk.log.map(function (e) {
      var lag = (['tradeK', 'quoteK', 'refWidthPct', 'maxHalfPct'].indexOf(e.key) !== -1 && e.value < prev[e.key]) ? 1 : 5;
      var r = '<tr><td class="n">' + dshort(data.dates[e.day - lag]) + '</td><td>' + KEYNAME[e.key] + '</td><td class="n">' + kval(e.key, prev[e.key]) + '</td><td class="n cal">' + kval(e.key, e.value) + '</td><td class="n">' + lag + ' business day' + (lag > 1 ? 's' : '') + '</td><td class="n end">' + dshort(data.dates[e.day]) + '</td></tr>';
      prev[e.key] = e.value; return r;
    });
    $('logBody').innerHTML = rows.join('') || '<tr><td colspan="6" class="empty">No changes</td></tr>';
  }
  function renderSnapshot() {
    var c = B.snapshotCheck(window.TXSE_SNAPSHOT);
    $('snapSub').textContent = c.outside.length + ' of ' + c.executed + ' executed auctions printed outside the final published band';
    $('snapBody').innerHTML = c.outside.map(function (r) {
      return '<tr><td class="sym" style="position:static">' + r.symbol + '</td><td>' + r.auction + '</td><td class="n">' + r.lower.toFixed(2) + '</td><td class="n">' + r.upper.toFixed(2) + '</td><td class="n warn">' + r.official.toFixed(2) + '</td><td class="n">' + num(r.executed) + '</td><td class="n end">$' + r.gap.toFixed(2) + '</td></tr>';
    }).join('');
  }

  // ------------------------------------------------------------ csv
  function csv() {
    var head = ['date', 'symbol', 'method', 'prod_lower', 'prod_upper', 'cal_lower', 'cal_upper', 'unconstrained_price', 'prod_inside', 'cal_inside', 'prod_priced_out', 'cal_priced_out'];
    var lines = [head.join(',')];
    A.prodRows.forEach(function (r, i) {
      var c = A.calRows[i];
      lines.push([r.x.date, r.x.sym, r.method, usd(r.lower), usd(r.upper), usd(c.lower), usd(c.upper), usd(r.x.pu), r.inside, c.inside, r.pricedOut, c.pricedOut].join(','));
    });
    var a = document.createElement('a');
    a.href = URL.createObjectURL(new Blob([lines.join('\n')], { type: 'text/csv' }));
    a.download = 'txse-band-calibration-' + Math.round(state.alpha * 100) + 'pct.csv'; a.click();
  }

  // ------------------------------------------------------------ wiring
  function renderAll() {
    compute();
    document.querySelectorAll('.seg-btn').forEach(function (b) { b.classList.toggle('on', +b.getAttribute('data-alpha') === state.alpha); });
    renderTiles(); renderMethods(); renderFrontier(); renderReplaySelect(); renderReplay(); renderSymbols(); renderLog();
  }
  $('date').textContent = dlong(data.dates[data.dates.length - 1]);
  $('asOf').textContent = 'backtest';
  document.querySelectorAll('.seg-btn').forEach(function (b) {
    b.addEventListener('click', function () { state.alpha = +b.getAttribute('data-alpha'); var u = new URL(location.href); u.searchParams.set('target', Math.round(state.alpha * 100)); history.replaceState(null, '', u); renderAll(); });
  });
  $('replaySel').addEventListener('change', function () { state.replay = +this.value; renderReplay(); });
  $('search').addEventListener('input', function () { state.q = this.value; renderSymbols(); });
  $('csvBtn').addEventListener('click', csv);
  $('symBody').addEventListener('click', function (e) {
    var pin = e.target.closest('.pin-btn');
    if (pin) {
      var s = pin.getAttribute('data-symbol'), i = pinned.indexOf(s);
      if (i === -1) pinned.push(s); else pinned.splice(i, 1);
      try { localStorage.setItem(PIN_KEY, JSON.stringify(pinned)); } catch (err) { /* private mode */ }
      renderSymbols(); return;
    }
    var cell = e.target.closest('td.click');
    if (cell) { state.replay = +cell.getAttribute('data-i'); renderReplaySelect(); $('replaySel').value = String(state.replay); renderReplay(); $('replay').scrollIntoView({ behavior: 'smooth', block: 'center' }); }
  });
  renderAll(); renderSnapshot();
  console.log('Band Calibration computed in ' + Math.round(performance.now() - t0) + ' ms');
})();
