# Collaboration Workflow & Project Memory

## Workflow (user <-> assistant)
- User runs commands in Fedora terminal and pastes output into chat.
- Assistant provides complete file rewrites via heredoc:
    cat > path/to/file << 'EOF' ... full file ... EOF
- NO manual edits by user. All changes arrive as copy-paste terminal commands.
- NEW CHAT SESSION: paste this file first to restore context.

## Project
- Path: ~/Downloads/Fable_Mexc_online_trading_botyrius_backup
- MEXC trading bot: Next.js app + TS engine + Postgres (db: fable_mexc_bot, candles)
- Backtest: npx tsx backtest-advanced.ts --symbol SYM --timeframe Min15 --days N --compare

## Key facts established
- Backtest INCLUDES fees/slippage.
- Baseline = base signal + FIXED TP/SL exits.
- Advanced = base signal + MTF confluence filter + ATR exits.
- => The baseline-vs-advanced A/B was CONFOUNDED (filter and exit changed together).
   Must isolate via 2x2: {filter on/off} x {fixed/ATR exits}.
- 60d results, 4 symbols: baseline avg -6.34 USDT/trade, advanced -7.29 USDT/trade.
   Both unprofitable; 1-5pp below breakeven win rate; churn ~3.5 trades/day/symbol.
- Suspected: churn consuming small gross edge; HTF trend filter starves range entries;
   fixed exits not volatility-scaled (per-symbol loss profiles differ wildly).

## Current phase
- Phase 0: audit backtest-advanced.ts for lookahead bias, same-bar TP/SL resolution,
  fee/slippage values, and confounded exit logic.

## Audit findings (backtest-advanced.ts) — Phase 0
- F1 CRITICAL: entry fee never charged (exit-only taker fee); slippage=0, funding=0.
- F2 CRITICAL: high/low never used; SL/TP/trail checked at closes only, filled at close price.
- F3 CRITICAL (suspected): htfCandles.slice(0, i+1) indexes Min60 array with Min15 counter
  -> future HTF leak; for i>=1439 passes ENTIRE 60d HTF history. Pending advanced-strategy.ts.
- F4: sniper strategy absent from backtest (only trend/range trades generated).
- F5: backtest config != live config (RSI 70/30 vs 65/35, adxRange 20 vs 29, lev 5 vs 3).
- F6: fills at signal-bar close, not next-bar open.
- F7: DD understated (equity marked only at trade close).
- CORRECTION: both arms use same ATR exits; A/B differs only by MTF gate + possible sizeUsdt override.
- Open: avg win/loss (~190/~130) too large for 500x5 notional + ATR stops -> check dynamicSize in strategy.ts.
- ORDER: fix harness FIRST, re-baseline, only then touch strategy. No tuning against broken harness.

## Batch 2 findings (advanced-strategy.ts, strategy.ts, sniper.ts)
- F3 CONFIRMED: backtest-advanced.ts:292 slices Min60 array with Min15 index i;
  timeframeDirection reads LAST candle of slice -> future vote. Both MTF alignment (trend)
  and HTF BB position (range) consume future closes. ~76% of run saw full future HTF.
  => Advanced-arm results VOID. Gate had future knowledge and still lost.
- Sizing resolved: both arms ~1% risk, 25% cap -> 2500 margin x5 = 12.5k notional.
  A/B was gate-only (identical sizes) — but the gate leaked the future.
- F9 NEW (live config bug): adxRangeThreshold 29 >= adxTrendThreshold 25 -> detectRegime
  can never return "neutral" -> live bot NEVER stands aside. Backtest v1 used 25/20.
- F4 RESOLVED: sniper (detectSniper) was NEVER backtested; it is a live Min5 exchange-wide
  scan with 30-min shadow grading (direction, not PnL). Sniper viability unknown until now.
- Minor: MTF layer applies htfEma(9/21) to the LTF vote too (benign: same as bot 9/21);
  ML gate must stay neutral (threshold 0.5) in backtests (stub model).

## Delivered (harness v2)
- backtest-advanced.ts v2: next-open fills, entry+exit fees, slippage, intra-bar SL/TP/trail
  (conservative same-bar: SL first), gap-aware fills, closed-HTF-only time-sliced windows,
  MTM equity/DD, --matrix (gate x exits 2x2), --compare, --dump CSV, live-config parity
  with F9 warning, gate stats, per-trade R/MAE/MFE. Partial-TP feature removed (unused+buggy).
- backtest-sniper.ts NEW: replays detectSniper (rolling 200-candle window = live parity)
  with next-open (default) or signal-close fills, fees+slippage, conservative same-bar rule,
  R/MAE/MFE, breakdowns by signalType (sweep/sigma) and direction, --sigma/--vol-mult overrides.
- Defaults: fees 0.0002 (USER: verify actual MEXC taker tier!), slippage 0.0003,
  leverage from live config (3). Expect v2 numbers worse than v1 — v2 is the honest reading.

## Next
- Run matrix + sniper on 4 symbols; collect CSVs. Decision rules:
  sniper breakeven WR at 3:1 after costs ~26-28%; trend/range breakeven at 1.67:1 ~38%+.
  Then: fix live adx config (F9), decide gate/exits/sniper fate from evidence.

## Batch 2 findings (advanced-strategy.ts, strategy.ts, sniper.ts)
- F3 CONFIRMED: backtest-advanced.ts:292 slices Min60 array with Min15 index i;
  timeframeDirection reads LAST candle of slice -> future vote. Both MTF alignment (trend)
  and HTF BB position (range) consume future closes. ~76% of run saw full future HTF.
  => Advanced-arm results VOID. Gate had future knowledge and still lost.
- Sizing resolved: both arms ~1% risk, 25% cap -> 2500 margin x5 = 12.5k notional.
  A/B was gate-only (identical sizes) — but the gate leaked the future.
- F9 NEW (live config bug): adxRangeThreshold 29 >= adxTrendThreshold 25 -> detectRegime
  can never return "neutral" -> live bot NEVER stands aside. Backtest v1 used 25/20.
- F4 RESOLVED: sniper (detectSniper) was NEVER backtested; it is a live Min5 exchange-wide
  scan with 30-min shadow grading (direction, not PnL). Sniper viability unknown until now.
- Minor: MTF layer applies htfEma(9/21) to the LTF vote too (benign: same as bot 9/21);
  ML gate must stay neutral (threshold 0.5) in backtests (stub model).

## Delivered (harness v2)
- backtest-advanced.ts v2: next-open fills, entry+exit fees, slippage, intra-bar SL/TP/trail
  (conservative same-bar: SL first), gap-aware fills, closed-HTF-only time-sliced windows,
  MTM equity/DD, --matrix (gate x exits 2x2), --compare, --dump CSV, live-config parity
  with F9 warning, gate stats, per-trade R/MAE/MFE. Partial-TP feature removed (unused+buggy).
- backtest-sniper.ts NEW: replays detectSniper (rolling 200-candle window = live parity)
  with next-open (default) or signal-close fills, fees+slippage, conservative same-bar rule,
  R/MAE/MFE, breakdowns by signalType (sweep/sigma) and direction, --sigma/--vol-mult overrides.
- Defaults: fees 0.0002 (USER: verify actual MEXC taker tier!), slippage 0.0003,
  leverage from live config (3). Expect v2 numbers worse than v1 — v2 is the honest reading.

## Next
- Run matrix + sniper on 4 symbols; collect CSVs. Decision rules:
  sniper breakeven WR at 3:1 after costs ~26-28%; trend/range breakeven at 1.67:1 ~38%+.
  Then: fix live adx config (F9), decide gate/exits/sniper fate from evidence.

## Harness v2 — verification notes
- tsc errors on first check were artifacts: passing files to tsc ignores tsconfig.json
  (ES5 default -> TS2802 on Map spreads) and skips skipLibCheck (drizzle node_modules noise).
  Correct check: npx tsc --noEmit --target es2020 --module commonjs --moduleResolution node
                --esModuleInterop --skipLibCheck backtest-advanced.ts backtest-sniper.ts
- Added process.exit(0) guard after main() in both harnesses (lib/sniper imports db pool;
  idle pg pool can keep event loop alive -> hang after report).
- Known approximation (documented): stop/trail level moves computed at bar close take
  effect from the NEXT bar (matches live cadence); rare same-bar close-through cases
  of a just-moved stop resolve next bar. Conservative direction overall.

## WLD matrix results (harness v2, 60d, fees 0.02% slip 0.03%)
- EXITS are the dominant variable: fixed beats adaptive by ~7.5 USDT/trade
  (+0.64 vs -6.86). BE-move@1ATR + trail converts winners to scratches:
  TP count 101->66, WR -10.2pp, churn +40 trades. Signal-exits all losers.
  => Pending 3-symbol confirm: kill adaptive exits, kill MTF gate (gate+fixed
  WORSE than base+fixed: -1.77 vs +0.64 — anti-selects even honestly).
- base+fixed = statistical breakeven (95% CI ~ +/-16 on 254 trades).
  Gross edge ~ +7/trade exists; costs ~7/trade consume it. Churn hypothesis CONFIRMED.
- range > trend in 4/4 cells (trend neg all cells; range pos all cells, best:
  base+fixed +1336 @43.5% WR). CAVEAT: run used live's broken ADX 25/29 + RSI 65/35.
- Sniper first backtest (WLD Min5): n=5, all sweeps, 60% WR, +0.74R avg, PF 2.73.
  Shape is right; evidence insufficient. 100% of losers were >=+1R first ->
  BE-at-+1R is candidate improvement AFTER breadth test. Sigma never fired @3.5.
- User confirmed: live fees currently 0 (promo) but 0.02% is the design target.
- Next: 3-symbol matrix+sniper; F9 A/B (--adx-range 20, exits fixed);
  sniper breadth over 16-symbol liquid-alt basket (bias noted: fixed basket,
  not live "top movers" ranking).

## Round 2 results (4-symbol matrix + sniper, harness v2, 60d, fees 0.02% slip 0.03%)
- AGGREGATE matrix (exp/trade): base+adaptive -5.29 | gate+adaptive -5.56 |
  base+fixed -3.09 | gate+fixed -4.32.
- DECISIONS: (1) MTF gate KILLED (worse in both exit modes, 3/4 symbols, 3rd strike).
  (2) Adaptive exit bundle KILLED (fixed better by ~2.2/trade). Salvage: trail exits
  were +52.6/trade on 47 exits; signal exits -36.6/trade; BE-move collapses WR.
  -> testing trailonly mode (fixed SL/TP + momentum trail only).
  (3) Trend entries: negative in 14/16 cells -> prime suspect for redesign/disable.
  Correction: "range>trend" from WLD did NOT generalize (range pos 2/4 syms, ~0 agg).
- Cost arithmetic: base+fixed gross ~+4.4/trade vs costs ~7.4/trade (fees 2.95 +
  slip ~4.5). Levers: maker entries, selectivity, not just fewer trades.
- SNIPER aggregate (359 trades, Min5, 4 syms): -0.159R, PF 0.81, cost ~0.2R/trade
  -> gross ~+0.04R = no raw edge as-is. WLD n=5 was luck. Structural facts:
  (a) 37.5% of SL losers touched +1R first (consistent 35-41%) -> BE-at-+1R lever;
  (b) R-dist bimodal: 74% full SL / 25% full TP; (c) no directional edge (regime noise);
  (d) sigma n=9 unevidenced.
- HYPE warning: gate+adaptive +12.1% is single-cell luck; no per-symbol configs.
- Fees: live promo is 0% but design target 0.02% (user confirmed).

## Round 3 (delivered)
- backtest-advanced.ts: + --exits trailonly (fixed SL/TP, momentum trail only,
  no BE move, no signal exits; TP suspends once trailing activates), + --offset-days.
- backtest-sniper.ts v2: + --be-at R (stop->entry after +R touch, next-bar effective,
  exits tagged "be"), --tp-ratio, --min-stop-pct, --offset-days (pseudo-OOS),
  stop-distance bucket diagnostics, MFE-before-SL-death table, frozen initial risk
  as R denominator.
- Experiments: R3.1 sniper default (regression+diagnostics), R3.2 --be-at 1.0,
  R3.3 --be-at 1.0 --offset-days 60 (OOS check of the BE hypothesis),
  R3.4 F9 A/B (--exits fixed --adx-range 20), R3.5 trailonly, R3.6 breadth 16 alts.

## Round 3 data (user ran round-2 commands; v2 code still unapplied at that point)
- BREADTH sniper (15 syms, 60d): 1,899 trades, avg -0.158R (matches 4-sym -0.159R).
  Pooled 19 syms / 2,258 trades: net -0.158R, gross ~0.
  SWEEP: -0.174R, n=2,158, 95% CI (-0.24,-0.11) -> DEAD. 3/15 syms positive, no pattern.
  SIGMA: n=100, WR 35% @ ~3:1, +0.19R NET — only live wire; only ~1 SE above zero (could
  be luck) -> triple sample before any decision; NO parameter tuning until n>=300.
- F9 A/B (WLD): adx-range 20 WORSE (+0.64 -> -5.83). Neutral zone deleted 43 profitable
  ADX 20-25 range trades (-721); path dependence refilled slots with 20 extra trend
  entries (-788). F9 is a bug but blind fix unprofitable on WLD; trend entries remain
  the core loss driver. TAO/LINK/HYPE pending (R3.4).
- KILL list (robust n): MTF gate, adaptive exits (except trail), trend entries, sweeps.
  ALIVE list (underpowered): sigma, trail exits, BE-at-+1R restructure, range (unstable).
- R3.7 delivered: agg_sniper.py aggregator; runs: baseline offsets 60/120 + BE@1.0
  offsets 0/60 over 19 symbols; decisions from aggregates A-E.
- Superseded: R3.2/R3.3 (4-symbol BE) by R3.7 (19-symbol BE, 2 windows, n~1900 each).

## Round 3 verdicts (R3.1-R3.5)
- BE-at-+1R (R3.2 vs R3.1): DEAD. Aggregate +0.017R = wash. Mechanism: saves ~80 SL
  deaths (+80R) but forfeits 26 TPs x ~2.7R (-70R) and pays 142 BE exits x -0.13R
  ("free" BE still costs round-trip fees/slip; tight stops -> huge cost-per-R),
  plus churn +36 trades. Structural: 53% of trades touch +1R; 47.6% of touchers
  run to 3R -> full-BE forfeits a coin-flip 3R tail.
- Correct instrument = PARTIAL at +1R (bank half, BE rest), est. ceiling ~+0.13R/trade.
  CANNOT save sweeps (-0.17R + 0.13R = still dead). Deferred until a live signal
  survives (design exits around it, not before).
- Stop-width (observational, window 0): stops <0.6% -> -0.27R (n~226) vs >=0.6% ->
  ~breakeven (n~132). LINK near-monotonic. Mechanisms: wick-outs + cost-per-R.
  OOS validation = optional R3.7 minstop run. Informs future stop design.
- F9 closed: adx-range 20 aggregate WORSE (-3.09 -> -4.46/trade); blocked ADX 20-25
  band was net-positive. ADX regime layer = second-order. Fix live config for
  correctness only. Entries (trend neg everywhere, range ~0) remain the problem.
- Sigma yellow flag: offset-60 BE-mode, 4 orig syms: -0.38R/18 (caveats: BE distortion,
  wrong symbols — breadth carried sigma). R3.7 clean runs decide.
- Trailonly: WLD partial showed 270 trades (churn from faster trail exits), WR 40.7%;
  full digest pending from logs.

## R3.7 (reduced, running)
- Baseline offsets 60/120 across 19 symbols + aggregator (agg_sniper.py).
- BE-at-scale runs CUT (hypothesis dead). Optional: --min-stop-pct 0.6 offset-60 OOS check.
- DECISION RULES (pre-registered): sigma pooled n~300 avgR >= +0.10 -> graduate to core,
  design partial-exit around it. Sigma decays toward 0/neg -> regime luck; pivot to
  entry design from scratch (alive list shrinks to trail exits only).

## Round 3 verdicts (R3.1-R3.5)
- BE-at-+1R (R3.2 vs R3.1): DEAD. Aggregate +0.017R = wash. Mechanism: saves ~80 SL
  deaths (+80R) but forfeits 26 TPs x ~2.7R (-70R) and pays 142 BE exits x -0.13R
  ("free" BE still costs round-trip fees/slip; tight stops -> huge cost-per-R),
  plus churn +36 trades. Structural: 53% of trades touch +1R; 47.6% of touchers
  run to 3R -> full-BE forfeits a coin-flip 3R tail.
- Correct instrument = PARTIAL at +1R (bank half, BE rest), est. ceiling ~+0.13R/trade.
  CANNOT save sweeps (-0.17R + 0.13R = still dead). Deferred until a live signal
  survives (design exits around it, not before).
- Stop-width (observational, window 0): stops <0.6% -> -0.27R (n~226) vs >=0.6% ->
  ~breakeven (n~132). LINK near-monotonic. Mechanisms: wick-outs + cost-per-R.
  OOS validation = optional R3.7 minstop run. Informs future stop design.
- F9 closed: adx-range 20 aggregate WORSE (-3.09 -> -4.46/trade); blocked ADX 20-25
  band was net-positive. ADX regime layer = second-order. Fix live config for
  correctness only. Entries (trend neg everywhere, range ~0) remain the problem.
- Sigma yellow flag: offset-60 BE-mode, 4 orig syms: -0.38R/18 (caveats: BE distortion,
  wrong symbols — breadth carried sigma). R3.7 clean runs decide.
- Trailonly: WLD partial showed 270 trades (churn from faster trail exits), WR 40.7%;
  full digest pending from logs.

## R3.7 (reduced, running)
- Baseline offsets 60/120 across 19 symbols + aggregator (agg_sniper.py).
- BE-at-scale runs CUT (hypothesis dead). Optional: --min-stop-pct 0.6 offset-60 OOS check.
- DECISION RULES (pre-registered): sigma pooled n~300 avgR >= +0.10 -> graduate to core,
  design partial-exit around it. Sigma decays toward 0/neg -> regime luck; pivot to
  entry design from scratch (alive list shrinks to trail exits only).

## R3.7 verdicts (FINAL for Min5 sniper + Min15 system)
- SIGMA DEAD: pooled n=302, avgR -0.066; decay +0.19 -> +0.07 -> -0.40 across windows
  = regime luck. NEAR/SUI/WIF pooled-positive cells are base-rate chance (19 syms x 3 windows).
- Min-stop filter DEAD OOS: -0.097R (n=1301) vs -0.095R baseline = perfect null.
- TRAILONLY DEAD: -3.90/trade agg vs -3.09 base+fixed; trail exits themselves +2834/49
  but churn + TP interplay eat it. Lesson: exit engineering cannot fix entry with no edge.
- FULL SCOREBOARD: every component null or negative at honest costs, ~11k trades of evidence.
  Root physics: Min5/Min15 stops 0.3-0.6% vs ~0.07-0.1% friction -> ~0.15-0.2R/trade toll.
- LIVE SAFETY: pending user confirmation (config mode=live status=running but
  allowLong/Short false, grid off; engine sniper execution path unverified).

## R4 (running): the game-change test — pre-registered
- Design: Min60, 180d x 3 windows (offsets 0/180/360) x 9 symbols.
  RANGE + maker-modeled entry (upper bound; non-fill risk not modeled).
  TREND + taker entry (honest). --exits fixed, --strategy forced (bypasses regime gate).
- PASS: pooled n>=100, avgR >= +0.05R, positive in >=2/3 windows -> v3 core, build execution around it.
- FAIL: recommend NO real-money deployment; continue research (H4/D1) or stop.
- Patched: --strategy, --maker-entry (entry slip x0.25, entry fee x0.5; exits unchanged).

## R4 verdict: BOTH ARMS FAIL (pre-registered rules)
- Range (maker, Min60, 9syms x 3 windows): pooled ~-0.07R (n~4300). Trend: ~-0.05R (n~6300).
- Failure PATTERN is the lesson: window 0 favored range, window -360 favored trend ->
  these are regime-conditional signals with no regime-timing mechanism. Structural fail.
- User direction: continue search, outside-the-box. Leverage rejected as edge source
  (gross expectancy ~-0.08R even at zero fees; leverage multiplies negative edge +
  nonlinear liquidation risk). Rapid-exit-on-sweeps = testable from CSVs (exit_sweep.py,
  upper-bound TP-at-X analysis over all 7124 trades).
- New priority menu: T1 funding carry (delta-neutral) > T2 listing momentum >
  T3 D1 time-series momentum > T4 daily-level sweeps (low prior). Each gets
  pre-registered pass rules before any code is written.
- STILL PENDING: user confirmation that live instance is paper-only (asked 3x).
