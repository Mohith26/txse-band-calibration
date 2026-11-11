# Band Calibration for TXSE Participation Bands

**Live demo:** https://mohith26.github.io/txse-band-calibration/

An unofficial concept feature for the Texas Stock Exchange: a **Band Calibration** tab in the Auction Viewer that measures how often each closing auction clears outside its final Participation Band, and recalibrates the band parameters (within the ranges Rule 11.022(a)(20) already permits) so that rate is about the same, and close to a target, for every method.

Unofficial concept demo by Mohith Gajjela. Not affiliated with TXSE. Synthetic data, except the Nov 10 panel, which uses public TXSE Auction Viewer data.

## Why

Since the Sep 9, 2026 circular, Late Auction Orders (LOC.L / LOO.L) priced through the band are adjusted to the band. The band is `median(P) ± k × MAD(P)` over a 5-minute window, with one `k = 5.0` for the Trade Method and the Quote Method, a 1.25% Reference Price width, a 5 × MPV / 5 bps floor and a 2.50% cap. The filing calls this "self-calibrating", and the midpoint and width do adapt. But a single k does not give the same protection everywhere:

* For a liquid stock, MAD over 5 minutes mostly measures bid/ask bounce, which says little about how far the close can move, so k = 5 can be too tight.
* For a thin ETF on the Reference Price Method, 1.25% per side is far wider than the close ever moves, so the band protects very little.

When the price the auction book wants to clear at lies outside the band, late interest on the far side is priced out and the auction prints somewhere else. The public Auction Viewer shows this happening: on **Tue Nov 10, 2026, 4 of the 30 auctions that executed printed outside their final published band** (IBOC and TXCP closes, DDS and SUNC opens; see `data/auction-viewer-2026-11-10.json`). The last published band is the one disseminated 5 seconds before the cross, per the FEED/BALE specs, so this is close to but not exactly the band applied at the print.

## What it does

1. **Implements the circular exactly** (`core/bands.js`): Trade Method, Quote Method and Reference Price Method with the published quality gates (minimum counts; corrected and late trades; crossed, locked, one-sided and over-5%-wide quotes), the MPV and basis-point floors, the maximum half-width, rounding to the tick.
2. **Implements TXSE auction price determination** from SR-TXSE-2026-006: maximum executed shares, then minimum total imbalance, then the entered price with unexecuted shares, then the price closest to the Volume Based Tie Breaker, and the clamp of Late Auction Orders to the band. The tests reproduce the filing's own Examples 1 and 2 ($50.10 for 2,000 shares; $49.00 for 10,000 unbanded vs $49.80 for 9,000 with the $49.80 x $50.20 band).
3. **Scores every past auction** with the smallest k (or Reference width) that would have kept its unconstrained clearing price inside the band, given the floors. Inside-the-band(k) is exactly `score <= k`, including tick rounding (tested).
4. **Calibrates with split conformal prediction**, separately per method (Mondrian): k is the ceil((n+1)(1 - alpha))-th smallest score, rounded up to 0.1 like the circular's values. It searches the permissible grid of MPV Floor (3-10), Basis Point Floor (1-25 bps) and Maximum Half-Width (2.5% or 5%), and keeps the combination with the fewest calibration misses above target and then the narrowest mean band.
5. **Walk-forward with the rule's notice periods:** recalibrates weekly on the trailing 30 sessions; reductions to k, the Reference width or the Maximum Half-Width take effect after 1 business day, everything else after 5; small reductions are skipped (deadband) so the Exchange is not publishing a circular every week.

## Results (synthetic backtest, target 2%)

30 evaluation sessions (Tue Sep 29 to Mon Nov 9, 2026) x 22 TXSE-listed symbols = 660 closing auctions. `node scripts/report.cjs 0.02` prints every number on the page.

| | Production (circular) | Calibrated |
|---|---|---|
| Auctions clearing outside the final band | 44 (6.7%) | 22 (3.3%) |
| Mean band half-width | 59.8 bps | 58.6 bps |
| Late shares priced out by the band | 433,900 | 196,500 |
| Trade Method outside rate | 11.9% | 4.9% |
| Quote Method outside rate | 6.8% | 4.1% |
| Reference Price outside rate (mean half-width) | 0.0% (125.0 bps) | 0.5% (76.0 bps) |

So the calibrated settings halve the outside-band rate without widening the average band: Trade and Quote bands get wider, Reference bands get much narrower. At a 1% target the outside rate falls to 2.4% with a wider average band (67.8 bps); at 5% it is 5.8% with a much narrower one (40.1 bps).

## Honest limitations

* **Synthetic data.** The 22 symbols, their Nov 10 prices and the band parameters are real; trades, quotes, auction books and imbalances are simulated (`core/bands.js`, seed 20261110). The miss rates depend on the simulator's tails, so they show the method, not TXSE's actual numbers. The real check would be to run the same scoring on TXSE's own auction books and consolidated tape.
* **The target is missed in the backtest** (3.3% vs 2%, Trade Method 4.9%): the conformal guarantee assumes exchangeable sessions, and volatility drifts week to week while each change waits out its notice period. The page shows the realized rate next to the target rather than claiming coverage.
* **"Unconstrained clearing price" is the target.** The simulator knows the price the book would clear at without the band. In production the equivalent is a counterfactual re-run of the auction with Late Auction Orders unclamped, which TXSE can compute from its own order book.
* Closing auctions only; opening auctions (mostly Reference Price Method in the Nov 10 data) would need their own calibration.
* The Observation Window (2-30 minutes) is not searched, because the simulator only generates the final 5 minutes.
* Per-symbol or per-liquidity-tier k would fit better than per-method k, but the rule defines one Trade k and one Quote k, so that would need a rule change; this demo stays inside the current rule.

## Novelty

The circular sets single values (k = 5.0 for both methods, 1.25% Reference width). I found no TXSE announcement, alert or filing about measuring or calibrating band coverage, and no other U.S. exchange publishing calibrated late-order bands: Cboe constrains late limit-on-close orders to the NBBO (and, for its corporate listings, to the 3:55 reference price), and NYSE and Nasdaq use fixed percentage collars or thresholds around a reference price. TXSE's MAD-based band is already the most adaptive of these; this feature tunes its parameters from outcomes.

## Run

```
node --test test/bands.test.cjs     # 10 tests
node scripts/report.cjs 0.02        # every number on the page
```

Static page, no build step: `index.html` + `viewer.css` (the public Auction Viewer stylesheet) + `app.css` + `app.js` + `core/bands.js`. Query parameter `?target=1|2|5` sets the target.

## Files

* `core/bands.js` - bands, auction matching, simulator, conformal calibration, walk-forward
* `test/bands.test.cjs` - unit tests (circular reproduction, filing examples, exact scoring, conformal coverage, no look-ahead, notice periods)
* `data/auction-viewer-2026-11-10.json` - public Auction Viewer snapshot (Nov 10, 2026)
* `scripts/report.cjs` - prints the results
