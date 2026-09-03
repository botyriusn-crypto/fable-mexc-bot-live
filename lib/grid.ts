import { db } from "./db"
import { botConfig, gridConfigs, gridOrders, trades, botLogs, positions, type BotConfig, type GridOrder } from "./db/schema"
import { eq, sql, and, or, isNull, lt, inArray, desc, isNotNull } from 'drizzle-orm'
import type { FeatureVector, IndicatorSnapshot } from "./indicators"
import { detectVolatilitySurge, adaptiveSpacing, type VolatilityState } from "./volatility-guard"
import type { Regime } from "./strategy"
import { loadModelFor, trainOnTrade, MODEL_IDS } from "./ml"
import { getExchangeClient, getFeeRates, type ExchangeClient, type Exchange } from "./exchange"
import type { Candle } from "./mexc/public"
import { getMexcSpecAsync } from "./mexc/precision"
import { livePrices } from "./mexc/ws"
import { isTradingHalted, marginBudgetRemaining, getRiskState } from "./risk-manager"
import { shouldGateEntry, recordShadowEntry, resolveShadowEntries, evaluateKillSwitch } from "./grid-flow"
import { checkGridExposureGate } from "./exposure"


// ── Setup cooldown (DB-backed, atomic) ──
// Previously these were in-memory Maps (`GRID_SETUP_COOLDOWN`,
// `BUDGET_TOO_SMALL_COOLDOWN`). That does NOT coordinate across multiple
// Fly.io machine instances (each has its own process memory) and does NOT
// survive a restart/deploy (fresh empty Map on boot). Either condition lets
// two ticks both read "no recent setup" and both proceed, producing
// duplicate ladder-setup attempts within the same second. Cooldown state now
// lives in gridConfigs.lastSetupAt / lastBudgetFailAt and is claimed with a
// single conditional UPDATE, so only one caller can ever win the race
// regardless of how many processes are evaluating it concurrently.
const COOLDOWN_MS = 60000; // 60 seconds between setups
// Separate, much longer backoff for a STRUCTURAL failure (budget cannot
// clear minimum notional at current leverage/allocation) as opposed to a
// transient one. Without this, a pair that mathematically cannot afford
// even 1 order retries every 60s forever, wasting cycles and flooding
// logs until the account balance or config changes.
const BUDGET_TOO_SMALL_BACKOFF_MS = 30 * 60 * 1000; // 30 minutes

// Atomically claim the setup cooldown for a symbol. Returns true only for
// the single caller that wins the race (the row's lastSetupAt was null or
// older than cooldownMs). Any concurrent caller — another tick on this
// instance, or a tick on a different machine entirely — sees the updated
// timestamp and gets `false`, so at most one ladder setup can proceed per
// cooldown window no matter how many processes are racing.
async function tryClaimSetupCooldown(symbol: string, cooldownMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - cooldownMs)
  const result = await db
    .update(gridConfigs)
    .set({ lastSetupAt: new Date() })
    .where(
      and(
        eq(gridConfigs.symbol, symbol),
        or(isNull(gridConfigs.lastSetupAt), lt(gridConfigs.lastSetupAt, cutoff)),
      ),
    )
    .returning({ id: gridConfigs.id })
  return result.length === 1
}

// Same pattern for the structural "budget too small" backoff.
async function tryClaimBudgetFailCooldown(symbol: string, backoffMs: number): Promise<boolean> {
  const cutoff = new Date(Date.now() - backoffMs)
  const result = await db
    .update(gridConfigs)
    .set({ lastBudgetFailAt: new Date() })
    .where(
      and(
        eq(gridConfigs.symbol, symbol),
        or(isNull(gridConfigs.lastBudgetFailAt), lt(gridConfigs.lastBudgetFailAt, cutoff)),
      ),
    )
    .returning({ id: gridConfigs.id })
  return result.length === 1
}

// Check (without claiming) whether the budget-too-small backoff is still
// active for a symbol, so setupGrid can skip early with an informative log
// exactly as it did before, without consuming a claim on every check.
async function isBudgetFailCooldownActive(symbol: string, backoffMs: number): Promise<{ active: boolean; remainingMs: number }> {
  const rows = await db.select({ lastBudgetFailAt: gridConfigs.lastBudgetFailAt }).from(gridConfigs).where(eq(gridConfigs.symbol, symbol)).limit(1)
  const last = rows[0]?.lastBudgetFailAt ? new Date(rows[0].lastBudgetFailAt as any).getTime() : 0
  const elapsed = Date.now() - last
  if (last > 0 && elapsed < backoffMs) {
    return { active: true, remainingMs: backoffMs - elapsed }
  }
  return { active: false, remainingMs: 0 }
}

// Grid trading engine: a ladder of buy levels below price with paired sell
// targets one spacing above. Profits from oscillation inside a range.
// Complements the signal strategies — regime detection auto-pauses the grid
// when the market starts trending (a breakout is the grid's worst enemy).


const TAKER_FEE = 0.0002
// Confirmed 0% maker fee tier on MEXC futures (Aug 2026), for resting/post-only
// fills only. Market-order fills — stop-loss, max-hold, recenter closes —
// always cross the book and pay TAKER_FEE regardless of maker mode.
const MAKER_FEE = 0.0000
// Maker mode risk controls: protect held inventory regardless of pause state.
const MAKER_STOP_LOSS_PCT = 0.04   // close at market if price moves 4% against entry
const MAKER_MAX_HOLD_MINUTES = 720 // force-close after 12 hours regardless of price
const TREND_MAX_HOLD_MINUTES = 180 // when paused (trending), give up on mean reversion after 3 hours
const MAKER_RECENTER_DRIFT_PCT = 0.15 // rebuild buy ladder if price drifts 15% from all resting buys

// MEXC's order/create returns the id nested (e.g. { data: { orderId } }) or as a
// bare value depending on endpoint. Extract a clean string id, never "[object Object]".
function extractOrderId(res: any): string | null {
  const d = res?.data ?? res
  if (d == null) return null
  if (typeof d === "object") {
    const id = d.orderId ?? d.order_id ?? d.id
    return id != null ? String(id) : null
  }
  return String(d)
}

// Drizzle wraps the real DB reason in err.cause; surface it so failures are legible.
function dbErr(err: unknown): string {
  if (err instanceof Error) {
    const cause = (err as any).cause
    const detail = cause?.detail ?? cause?.message ?? cause?.code
    return detail ? `${err.message} | cause: ${detail}` : err.message
  }
  return String(err)
}

// --- Maker mode (post-only resting orders) ---
// Global kill switch: OFF entirely unless GRID_MAKER=1. Per-symbol enablement
// is now DB-driven via gridConfigs.makerMode, settable from the dashboard —
// no more code edits/rebuilds needed to bring a new pair into maker mode.
// Only affects LIVE mode; paper mode always uses the virtual-fill path.
const MAKER_ENABLED = process.env.GRID_MAKER === "1"
function isMakerSymbol(gc: { makerMode?: boolean }): boolean {
  return MAKER_ENABLED && !!gc.makerMode
}



// Universal maker order placement with precision rounding for ALL symbols
async function placeRoundedMakerOrder(symbol: string, side: number, price: number, volume: number, leverage: number, exchange: ExchangeClient): Promise<any> {
  return exchange.placePostOnlyOrder({
    symbol,
    side: side as 1 | 2 | 3 | 4,
    price,
    volume,
    leverage,
  })
}

export interface GridConfig {
  id: number
  symbol: string
  timeframe: string
  enabled: boolean
  levels: number
  rangeAtrMult: number
  budgetPct: number
  leverage: number
  feeMarginMult: number
  autoPause: boolean
  makerMode: boolean
  // "neutral" = COMBO / Bitsgap-style two-sided grid (buys below + sells above).
  direction: "long" | "short" | "neutral" | "auto"
}
// Returns ALL grid configs, not just enabled ones. Disabling a pair should
// stop new buy ladders but must not abandon existing held inventory (a
// pending sell representing a real position) — the tick loop needs to keep
// seeing disabled-but-still-holding pairs so it can close that inventory out.
// runGridTick/runGridTickMaker already skip building fresh ladders via their
// own `if (!gc.enabled) return` checks, so filtering here is unnecessary and
// was silently orphaning held positions on any pair you disabled.
export async function getGridConfigs(): Promise<GridConfig[]> {
  const rows = await db.select().from(gridConfigs)
  return rows.map(r => ({
    id: r.id,
    symbol: r.symbol,
    timeframe: r.timeframe,
    enabled: r.enabled,
    levels: r.levels,
    rangeAtrMult: r.rangeAtrMult,
    budgetPct: r.budgetPct,
    leverage: r.leverage,
    feeMarginMult: r.feeMarginMult,
    autoPause: r.autoPause,
    makerMode: r.makerMode,
    direction: (r.direction as "long" | "short" | "neutral" | "auto") || "long",
  }))
}


export async function log(level: "info" | "trade" | "error", message: string, details?: unknown) {
  await db.insert(botLogs).values({
    level,
    message,
    details: details || null,
  })
}

export async function getActiveOrders(symbol?: string, timeframe?: string): Promise<GridOrder[]> {
  if (symbol && timeframe) {
    return db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe)))
  } else if (symbol) {
    return db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.symbol, symbol)))
  } else {
    return db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
  }
}

// Build the ladder: buy levels below current price across the lower half of
// the range. Sells are placed dynamically one spacing above each filled buy.



const GRID_STOP_LOSS_PCT = 0.05 // 5% adverse move triggers stop-loss

// Safety margin against liquidation, mirroring lib/exits.ts's approach for
// the trend engine: isolated-margin futures liquidate at roughly 1/leverage
// away from entry. A flat percentage stop that ignores leverage can end up
// set BEYOND where the exchange already force-liquidates at high leverage —
// meaning the bot's own stop never fires; forced liquidation does instead,
// at a worse price plus a penalty, with zero warning.
const GRID_LIQUIDATION_SAFETY_FACTOR = 0.75

const POST_SL_COOLDOWN_MS = 90 * 60 * 1000 // no fresh ladder for 90m after a stop-loss on this symbol
const RANGE_SL_SPACING_MULT = 1.0        // range SL sits one rung beyond the outermost level

async function markPostStopCooldown(symbol: string): Promise<void> {
  const until = new Date(Date.now() + POST_SL_COOLDOWN_MS).toISOString()
  await db.update(gridConfigs)
    .set({ metadata: sql`COALESCE(${gridConfigs.metadata}, '{}'::jsonb) || jsonb_build_object('postSlUntil', ${until}::text)` })
    .where(eq(gridConfigs.symbol, symbol))
}

async function postStopCooldownRemainingMs(symbol: string): Promise<number> {
  const rows = await db.select({ metadata: gridConfigs.metadata }).from(gridConfigs).where(eq(gridConfigs.symbol, symbol)).limit(1)
  const until = (rows[0]?.metadata as any)?.postSlUntil
  if (!until) return 0
  const rem = new Date(until).getTime() - Date.now()
  return rem > 0 ? rem : 0
}

function effectiveGridStopPct(leverage: number): number {
  const liquidationDistApprox = 1 / leverage
  return Math.min(GRID_STOP_LOSS_PCT, liquidationDistApprox * GRID_LIQUIDATION_SAFETY_FACTOR)
}

// Maker-mode held inventory uses the same liquidation-aware clamp so the coded
// stop always fires BEFORE the exchange force-liquidates at high leverage.
// Previously this helper was referenced in checkAllHeldPositionsRisk (the 20s
// fast risk-check) and runGridTickMaker but never defined — a ReferenceError
// that crashed the maker stop-loss path, leaving held positions unprotected.
function effectiveMakerStopPct(leverage: number): number {
  const lev = leverage && leverage > 0 ? leverage : 1
  const liquidationDistApprox = 1 / lev
  return Math.min(MAKER_STOP_LOSS_PCT, liquidationDistApprox * GRID_LIQUIDATION_SAFETY_FACTOR)
}

// Cancels other pending orders for this pair on the REAL exchange (not just
// the database) before marking them cancelled — otherwise any real resting
// order gets orphaned on MEXC while our records claim it's gone.
async function cancelOtherPendingOrders(active: GridOrder[], keepId: number, exchange: ExchangeClient): Promise<void> {
  const others = active.filter(x => x.id !== keepId && x.status === "pending")
  if (others.length === 0) return
  const realIds = others.filter(o => o.mexcOrderId).map(o => o.mexcOrderId!) as string[]
  if (realIds.length > 0) {
    try {
      await exchange.cancelOrders(realIds)
    } catch (err) {
      await log("error", `Grid stop-loss: failed cancelling ${realIds.length} real resting order(s) on exchange: ${dbErr(err)}`)
    }
  }
  await log("info", `[CancelOp] Line ~161: Cancelling orders`).catch(() => {});
  await db.update(gridOrders).set({ status: "cancelled" }).where(inArray(gridOrders.id, others.map(x => x.id)))
}

async function checkGridStopLoss(cfg: BotConfig, gc: GridConfig, price: number, exchange?: ExchangeClient): Promise<boolean> {
  const active = await getActiveOrders(gc.symbol, gc.timeframe)
  
  // Check Long inventory
  for (const o of active.filter(x => x.side === "sell" && x.buyPrice != null && x.status === "pending")) {
    const adverse = (o.buyPrice! - price) / o.buyPrice!
    if (o.slPrice != null ? price <= o.slPrice : adverse >= effectiveGridStopPct(o.leverage)) {
      if (cfg.mode === "live" && exchange) { try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 4, volume: o.quantity, leverage: o.leverage }) } catch (e) {} }
      const grossPnl = (price - o.buyPrice!) * o.quantity
      const { takerFeeRate: rtf1 } = getFeeRates(cfg.exchange as Exchange, o.symbol)
      const fees = (o.buyPrice! + price) * o.quantity * rtf1
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - fees}` }).where(eq(botConfig.id, 1))
      }
      const claimedLongStop = await db.update(gridOrders).set({ status: "filled" }).where(and(eq(gridOrders.id, o.id), eq(gridOrders.status, "pending"))).returning({ id: gridOrders.id })
      if (claimedLongStop.length > 0) await markPostStopCooldown(o.symbol).catch(() => {})
      if (claimedLongStop.length === 0) return false
      await cancelOtherPendingOrders(active, o.id, exchange ?? getExchangeClient(cfg.exchange as Exchange))
      await log("trade", `Grid ${o.symbol} STOP-LOSS closed @ ${price.toFixed(4)} | PnL ${(grossPnl - fees).toFixed(2)} USDT`)
      return true
    }
  }

  // Check Short inventory
  for (const o of active.filter(x => x.side === "buy" && x.buyPrice != null && x.status === "pending")) {
    const adverse = (price - o.buyPrice!) / o.buyPrice!
    if (o.slPrice != null ? price >= o.slPrice : adverse >= effectiveGridStopPct(o.leverage)) {
      if (cfg.mode === "live" && exchange) { try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 2, volume: o.quantity, leverage: o.leverage }) } catch (e) {} }
      const grossPnl = (o.buyPrice! - price) * o.quantity
      const { takerFeeRate: rtf2 } = getFeeRates(cfg.exchange as Exchange, o.symbol)
      const fees = (o.buyPrice! + price) * o.quantity * rtf2
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${grossPnl - fees}` }).where(eq(botConfig.id, 1))
      }
      await cancelOtherPendingOrders(active, o.id, exchange ?? getExchangeClient(cfg.exchange as Exchange))
      await db.update(gridOrders).set({ status: "filled" }).where(eq(gridOrders.id, o.id))
      await markPostStopCooldown(o.symbol).catch(() => {})
      await log("trade", `Grid ${o.symbol} SHORT STOP-LOSS closed @ ${price.toFixed(4)} | PnL ${(grossPnl - fees).toFixed(2)} USDT`)
      return true
    }
  }
  return false
}

// Pre-fetch MEXC specs before grid setup
// ── Auto-direction (COMBO ↔ one-sided switching) ──
// When a grid config has direction === "auto", the bot resolves the effective
// side each tick from the detected regime, with hysteresis to avoid whipsaw.
//   range   → neutral (COMBO: two-sided, mean-reversion)
//   trend   → long/short by EMA direction (one-sided, trend-following)
//   neutral → hold the last confirmed side (no flip on ambiguity)
// The resolved side only changes which NEW rungs get placed on the next
// rebuild — it never force-closes an existing position, so switching modes
// carries no cliff and no forced liquidation.
const AUTO_SIDE_CONFIRM_TICKS = 3
const AUTO_SIDE_STATE = new Map<string, { confirmed: "long" | "short" | "neutral"; pending: "long" | "short" | "neutral"; pendingCount: number }>()

function effectiveDirection(gc: GridConfig): "long" | "short" | "neutral" {
  if (gc.direction === "auto") return (gc as any)._autoSide || "neutral"
  return gc.direction
}

function resolveAutoSide(gc: GridConfig, snap: IndicatorSnapshot, regime: Regime): "long" | "short" | "neutral" {
  let desired: "long" | "short" | "neutral"
  if (regime === "range") desired = "neutral"
  else if (regime === "trend") desired = snap.emaFast > snap.emaSlow ? "long" : "short"
  else desired = "neutral" // neutral regime → default to COMBO (safe)

  const key = gc.symbol
  let st = AUTO_SIDE_STATE.get(key)
  if (!st) {
    st = { confirmed: "neutral", pending: desired, pendingCount: 0 }
    AUTO_SIDE_STATE.set(key, st)
  }

  if (st.pending === desired) st.pendingCount++
  else { st.pending = desired; st.pendingCount = 1 }

  if (st.pendingCount >= AUTO_SIDE_CONFIRM_TICKS && st.pending !== st.confirmed) {
    st.confirmed = st.pending
  }

  return st.confirmed
}

export async function setupGrid(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, volatility?: VolatilityState, exchange?: ExchangeClient, startAtPrice = false): Promise<void> {
  // ── Portfolio risk gate ── do not deploy NEW grid capital while the
  // portfolio-level risk layer is halted (daily loss / drawdown / margin cap).
  // Fill detection, stop-losses and teardown live in runGridTick and are
  // unaffected — this only prevents placing fresh grid orders.
  if (isTradingHalted()) {
    const rs = getRiskState()
    await log("info", `Grid ${gc.symbol}: setup skipped — risk layer halted (${rs?.reasons.join("; ") || "risk limit"})`)
    return
  }
  if (marginBudgetRemaining() <= 0) {
    await log("info", `Grid ${gc.symbol}: setup skipped — total margin cap reached, no budget for new orders`)
    return
  }

  // BUDGET-TOO-SMALL BACKOFF: check (without claiming) whether this symbol is
  // still in its 30-minute structural backoff. Checked before the setup
  // cooldown claim so we don't burn a setup-cooldown claim on a symbol we're
  // going to skip anyway for a different reason.
  const postSlRemaining = await postStopCooldownRemainingMs(gc.symbol)
  if (postSlRemaining > 0) {
    await log("info", `Grid ${gc.symbol}: post-stop-loss cooldown — ${Math.ceil(postSlRemaining / 60000)}m remaining, skipping setup`)
    return
  }
  const budgetFailState = await isBudgetFailCooldownActive(gc.symbol, BUDGET_TOO_SMALL_BACKOFF_MS)
  if (budgetFailState.active) {
    await log("info", `Grid ${gc.symbol}: Budget too small for current allocation, backing off - ${Math.floor(budgetFailState.remainingMs / 60000)}m remaining, skipping setup`);
    return;
  }

  // COOLDOWN LOCK: Prevent duplicate setups. Atomic DB claim — only one
  // caller (across all processes/instances) can win this per COOLDOWN_MS
  // window, unlike the old in-memory Map which let concurrent instances or
  // overlapping ticks each think they were first.
  const claimedSetup = await tryClaimSetupCooldown(gc.symbol, COOLDOWN_MS);
  if (!claimedSetup) {
    await log("info", `Grid ${gc.symbol}: Cooldown active or claimed by concurrent instance, skipping setup`);
    return;
  }

  // BUDGET ENFORCEMENT: Hard cap orders and check existing before setup
  const MAX_ORDERS = 8; // Never exceed 8 orders (4 per side) regardless of config
  
  if (cfg.mode === "live") {
    const existingOrders = await db.select().from(gridOrders)
      .where(and(eq(gridOrders.symbol, gc.symbol), eq(gridOrders.status, "pending")));
    
    if (existingOrders.length >= MAX_ORDERS) {
      await log("info", `Grid ${gc.symbol}: Budget enforced - already has ${existingOrders.length}/${MAX_ORDERS} orders, skipping setup`);
      return;
    }
  }

  // Guard: Don't rebuild if we just set up (prevent duplicate orders)
  const recentOrders = await db.select().from(gridOrders)
    .where(eq(gridOrders.symbol, gc.symbol))
    .orderBy(desc(gridOrders.id))
    .limit(1);
  
  if (recentOrders.length > 0 && recentOrders[0].status === "pending") {
    const orderAge = Date.now() - new Date(recentOrders[0].createdAt).getTime();
    if (orderAge < 60000) { // Less than 1 minute old
      await log("info", `Grid ${gc.symbol}: Skipping rebuild - orders are ${Math.floor(orderAge/1000)}s old`);
      return;
    }
  }

// Cleanup: Cancel all existing orders for this symbol before rebuilding
  if (cfg.mode === "live" && exchange) {
  // Fetch MEXC specs for this symbol before calculating orders
  try {
    await getMexcSpecAsync(gc.symbol, snap.price);
  } catch (err) {
    await log("error", `Grid ${gc.symbol}: Failed to fetch MEXC specs: ${dbErr(err)}`);
  }

  const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)

    try {
      const existingOrders = await getActiveOrders(gc.symbol, gc.timeframe)
      if (existingOrders.length > 0) {
        const orderIds = existingOrders.map(o => o.mexcOrderId).filter((id): id is string => !!id)
        if (orderIds.length > 0) {
          await client.cancelOrders(orderIds)
          await log("info", `Grid ${gc.symbol}: Cancelled ${orderIds.length} existing orders before rebuild`)
        }
        await db.update(gridOrders)
          .set({ status: "cancelled" })
          .where(eq(gridOrders.symbol, gc.symbol))
      }
    } catch (err) {
      await log("error", `Grid ${gc.symbol}: Failed to cleanup old orders: ${dbErr(err)}`)
    }
  } else {
    // Paper mode: just mark old orders as cancelled
    await db.update(gridOrders)
      .set({ status: "cancelled" })
      .where(eq(gridOrders.symbol, gc.symbol))
  }

  const center = snap.price
  const configuredHalf = snap.atr * gc.rangeAtrMult
  // Spacing must cover the worst-case fee mix: entry can be maker (post-only,
  // 0% today) but an adverse exit (stop-loss/max-hold) always crosses as a
  // taker market order. Using real entry-fee basis instead of assuming taker
  // on both legs, which was needlessly widening every maker pair's grid.
  const { makerFeeRate: realMakerFeeRate, takerFeeRate: realTakerFeeRate } = getFeeRates(cfg.exchange as Exchange, gc.symbol)
  const entryFeeRate = isMakerSymbol(gc) ? realMakerFeeRate : realTakerFeeRate
  const breakeven = center * (entryFeeRate + realTakerFeeRate)
  const feeBasedMin = breakeven * gc.feeMarginMult
  const pctBasedMin = center * 0.005 // 0.5% floor — prevents zero-movement TP at high price magnitudes
  const minSpacing = Math.max(feeBasedMin, pctBasedMin)
  // GEOMETRIC SPACING: Widens gap between orders as price moves away from center.
  // Protects budget from deploying too fast during flash crashes/pumps.
  const bbWidth = snap.bbUpper - snap.bbLower
  const bbBaseSpacing = bbWidth / 4
  const maxSpacing = center * 0.02 // 2% cap — grids farther than this never fill (dead capital)
let baseSpacing = Math.min(Math.max(bbBaseSpacing, minSpacing), maxSpacing)
if (effectiveDirection(gc) === "neutral") baseSpacing = Math.max(center * 0.006, minSpacing) // COMBO-DENSE
  const geomRatio = effectiveDirection(gc) === "neutral" ? 1.0 : 1.15 // COMBO-DENSE: uniform arithmetic spacing like Bitsgap
  const totalLevels = Math.max(1, Math.min(4, Math.floor(gc.levels / 2))) // Cap at 4 levels per side
  const effectiveLevels = gc.levels
  // Approximate half-range for DB logging
  let distAccum = 0
  for (let i = 1; i <= totalLevels; i++) distAccum += baseSpacing * Math.pow(geomRatio, i - 1)
  const effectiveHalf = Math.max(configuredHalf, distAccum)
  const lower = center - effectiveHalf
  const upper = center + effectiveHalf
  let effectiveBalance = cfg.paperBalance
  if (cfg.mode === "live") {
    try {
      const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)
      const assets = await client.getAccountAssets()
      await log("info", `[Balance] Fetched ${assets.length} assets from exchange`);
      const usdt = assets.find((a) => a.currency === "USDT") ?? null
      if (usdt) {
        effectiveBalance = Number(usdt.availableBalance)
        await log("info", `[Balance] USDT available: ${effectiveBalance.toFixed(2)}`);
        await log("info", `[Balance] Full USDT asset object: ${JSON.stringify(usdt)}`);
      } else {
        await log("error", `[Balance] USDT not found in assets: ${JSON.stringify(assets.slice(0, 3))}`);
      }
    } catch (err) {
      await log("error", `[Balance] Failed to fetch MEXC balance: ${err instanceof Error ? err.message : String(err)}`);
    }
  }
  const isNeutral = effectiveDirection(gc) === "neutral"
  const budget = (effectiveBalance * gc.budgetPct) / 100

  // Decide how many levels per side we can actually afford BEFORE
  // generating any orders. The old approach generated a fixed number of
  // orders first, then applied three separate, inconsistent trims after
  // the fact — one of which inflated per-order size without reducing the
  // count that was actually generated, and another which spliced the
  // combined buy+sell array directly, silently producing an uneven
  // buy/sell split for COMBO grids. Computing the count up front avoids
  // all of that: notionalPerLevel and the actual order count are always
  // derived from the same numbers.
  const MIN_NOTIONAL = 1.0
  const sidesPerLevel = isNeutral ? 2 : 1
  const maxLevelsByBudget = Math.max(0, Math.floor((budget * gc.leverage) / (MIN_NOTIONAL * sidesPerLevel)))
  const effectiveLevelsPerSide = Math.max(0, Math.min(totalLevels, MAX_ORDERS, maxLevelsByBudget))

  if (effectiveLevelsPerSide < 1) {
    await log("error", `Grid ${gc.symbol}: Budget ${budget.toFixed(2)} USDT too small for even 1 order per side at $${MIN_NOTIONAL} minimum notional. Need at least $${((MIN_NOTIONAL * sidesPerLevel) / gc.leverage).toFixed(2)} margin. Backing off ${BUDGET_TOO_SMALL_BACKOFF_MS/60000}m.`)
    await tryClaimBudgetFailCooldown(gc.symbol, BUDGET_TOO_SMALL_BACKOFF_MS)
    return
  }
  if (effectiveLevelsPerSide < totalLevels) {
    await log("info", `Grid ${gc.symbol}: Reducing levels from ${totalLevels} to ${effectiveLevelsPerSide} per side (minimum notional / order cap constraint, budget: ${budget.toFixed(2)})`)
  }

  const orderCount = effectiveLevelsPerSide * sidesPerLevel
  const notionalPerLevel = (budget / orderCount) * gc.leverage

  // Liquidation Safety Check: Ensure leverage isn't so high that MEXC liquidates 
  // the position before our 5% GRID_STOP_LOSS_PCT can trigger.
  // MEXC liquidates at roughly 100% / leverage adverse move.
  const liqDistancePct = 1.0 / gc.leverage
  if (liqDistancePct <= GRID_STOP_LOSS_PCT * 1.5) {
    await log("error", `Grid ${gc.symbol}: Refusing to build grid. Leverage ${gc.leverage}x is too high. Liquidation distance (${(liqDistancePct*100).toFixed(1)}%) is too close to stop-loss (${(GRID_STOP_LOSS_PCT*100).toFixed(1)}%). Reduce leverage to <= ${Math.floor(1.0 / (GRID_STOP_LOSS_PCT * 1.5))}x.`)
    await db.update(gridConfigs).set({ paused: true }).where(eq(gridConfigs.id, gc.id))
    return
  }

  const isShort = !isNeutral && effectiveDirection(gc) === "short"
let orders: any[] = []
  for (let i = 1; i <= effectiveLevelsPerSide; i++) {
    // Calculate cumulative distance for geometric spacing
    const dist = geomRatio === 1 ? baseSpacing * i : baseSpacing * (Math.pow(geomRatio, i) - 1) / (geomRatio - 1)

    if (isNeutral) {
      // COMBO: place BOTH buy below center AND sell above center for each rung
      const buyPrice = center - dist
      const sellPrice = center + dist
      if (buyPrice > 0 && Number.isFinite(buyPrice)) {
        orders.push({
          symbol: gc.symbol, timeframe: gc.timeframe, leverage: gc.leverage,
          spacing: baseSpacing, levelIndex: i, side: "buy", price: buyPrice,
          quantity: Number.isFinite(notionalPerLevel / buyPrice) ? notionalPerLevel / buyPrice : 0,
          status: "pending" as const,
        })
      }
      if (sellPrice > 0 && Number.isFinite(sellPrice)) {
        orders.push({
          symbol: gc.symbol, timeframe: gc.timeframe, leverage: gc.leverage,
          spacing: baseSpacing, levelIndex: i, side: "sell", price: sellPrice,
          quantity: Number.isFinite(notionalPerLevel / sellPrice) ? notionalPerLevel / sellPrice : 0,
          status: "pending" as const,
        })
      }
      continue
    }

    const orderPrice = isShort ? center + dist : center - dist
    if (orderPrice <= 0 || !Number.isFinite(orderPrice)) continue
    orders.push({
      symbol: gc.symbol,
      timeframe: gc.timeframe,
      leverage: gc.leverage,
      spacing: baseSpacing, // Base spacing stored, ratio applied dynamically
      levelIndex: i,
      side: isShort ? "sell" : "buy",
      price: orderPrice,
      quantity: Number.isFinite(notionalPerLevel / orderPrice) ? notionalPerLevel / orderPrice : 0,
      status: "pending" as const,
    })
  }
  // RANGE-AWARE SL: one rung beyond the outermost level, capped so it is never
  // looser than the legacy percentage stop. Carried into paired TP orders.
  {
    const buyPx = orders.filter(o => o.side === "buy").map(o => o.price)
    const sellPx = orders.filter(o => o.side === "sell").map(o => o.price)
    const rangeSlLong = buyPx.length ? Math.min(...buyPx) - baseSpacing * RANGE_SL_SPACING_MULT : null
    const rangeSlShort = sellPx.length ? Math.max(...sellPx) + baseSpacing * RANGE_SL_SPACING_MULT : null
    const pct = Math.min(effectiveGridStopPct(gc.leverage), effectiveMakerStopPct(gc.leverage))
    for (const o of orders) {
      if (o.side === "buy" && rangeSlLong != null) o.slPrice = Math.max(rangeSlLong, o.price * (1 - pct))
      if (o.side === "sell" && rangeSlShort != null) o.slPrice = Math.min(rangeSlShort, o.price * (1 + pct))
    }
    if (rangeSlLong != null || rangeSlShort != null)
      await log("info", `Grid ${gc.symbol}: range SL long=${rangeSlLong?.toFixed(6) ?? "-"} short=${rangeSlShort?.toFixed(6) ?? "-"} (spacing ${baseSpacing.toFixed(6)})`)
  }
// COMBO (neutral) grids: Place BOTH buy AND sell orders immediately (Bitsgap-style)
// This captures oscillations in both directions from the start. Order
// count is already correct at this point (computed before generation), so
// no post-hoc trimming is needed or performed here.
if (isNeutral) {
  const finalBuys = orders.filter(o => o.side === "buy").length;
  const finalSells = orders.filter(o => o.side === "sell").length;
  await log("info", `Grid ${gc.symbol}: COMBO mode - placing ${finalBuys} buy orders and ${finalSells} sell orders (two-sided ladder)`)
}
  
  if (volatility && volatility.surge) {
    await log("info", `Grid ${gc.symbol}: ${volatility.reason}`)
  }
  
  // Balance check: ensure we have enough margin for all orders
  if (cfg.mode === "live") {
    try {
      const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)
      const assets = await client.getAccountAssets()
      const usdtAsset = assets.find((a) => a.currency === "USDT")
      const availableBalance = usdtAsset ? Number(usdtAsset.availableBalance) : 0
      
      // Check existing orders for this symbol
      const existingOrders = await db.select().from(gridOrders)
        .where(and(eq(gridOrders.symbol, gc.symbol), eq(gridOrders.status, "pending")))
      const existingMargin = existingOrders.length * notionalPerLevel / gc.leverage
      
      const requiredMargin = orders.length * notionalPerLevel / gc.leverage
      const totalRequired = requiredMargin + existingMargin
      
      if (totalRequired > availableBalance * 0.95) {
        const maxOrders = Math.floor((availableBalance * 0.95 * gc.leverage) / notionalPerLevel)
        await log("error", `Grid ${gc.symbol}: Insufficient margin. Available: ${availableBalance.toFixed(2)} USDT, Required: ${requiredMargin.toFixed(2)} USDT. Reducing to ${maxOrders} levels.`)
        
        if (maxOrders <= 0) {
          await log("error", `Grid ${gc.symbol}: Cannot place any orders with available balance`)
          return
        }
        
        orders.splice(maxOrders)
      }
    } catch (err) {
      await log("error", `Grid ${gc.symbol}: Failed to check balance: ${dbErr(err)}`)
    }
  }
if (cfg.mode === "live") {
    let balanceExhausted = false
    for (const ord of orders) {
      if (balanceExhausted) break // Stop placing if balance is insufficient
      
      try {
        const isOpening = ord.buyPrice == null
        const side = ord.side === "sell"
          ? (isOpening ? 3 : 4)   // sell: open short (fresh) vs close long (has entry)
          : (isOpening ? 1 : 2)   // buy: open long (fresh) vs close short (has entry)
        let res: any;
        let retries = 0;
        const maxRetries = 3;
        
        while (retries < maxRetries) {
          try {
            res = await placeRoundedMakerOrder(ord.symbol, side, ord.price, ord.quantity, ord.leverage, exchange ?? getExchangeClient(cfg.exchange as Exchange));
            break; // Success, exit retry loop
          } catch (err) {
            const errMsg = dbErr(err);
            if (errMsg.includes("510") && retries < maxRetries - 1) {
              // Rate limit - wait and retry with exponential backoff
              const waitTime = Math.pow(2, retries) * 1000; // 1s, 2s, 4s
              await log("info", `Grid ${gc.symbol}: Rate limited, waiting ${waitTime}ms before retry ${retries + 1}/${maxRetries}`);
              await new Promise(r => setTimeout(r, waitTime));
              retries++;
            } else {
              throw err; // Not a rate limit or max retries reached
            }
          }
        }
        
        const oid = extractOrderId(res)
        await db.insert(gridOrders).values({ ...ord, mexcOrderId: oid, exchangeStatus: "new" })
        await log("info", `Grid ${gc.symbol}: resting ${ord.side} @ ${ord.price.toFixed(6)} id=${oid}`)
        await new Promise(r => setTimeout(r, 2000))
        
        // Add delay between order placements to avoid rate limits
        await new Promise(r => setTimeout(r, 1000))
      } catch (err) {
        const errMsg = dbErr(err)
        await log("error", `Grid ${gc.symbol}: ${ord.side} rejected @ ${ord.price.toFixed(6)}: ${errMsg}`)
        
        // Stop placing if balance is insufficient or position doesn't exist
        if (errMsg.includes("2005") || errMsg.includes("Balance insufficient")) {
          await log("error", `Grid ${gc.symbol}: Balance insufficient, stopping order placement`)
          balanceExhausted = true
          break
        }
        if (errMsg.includes("2009") || errMsg.includes("Position is nonexistent")) {
          await log("error", `Grid ${gc.symbol}: Cannot place ${ord.side} without position, stopping`)
          break
        }
      }
    }
  } else {
    if (orders.length > 0) await db.insert(gridOrders).values(orders)
  }
  await db.update(botConfig).set({ gridCenter: center, gridLower: lower, gridUpper: upper, gridSpacing: baseSpacing, gridEffectiveLevels: effectiveLevels, gridPaused: false }).where(eq(botConfig.id, 1))
  await log("info", `Grid set up: ${orders.length} ${isShort ? "sell" : "buy"} GEOMETRIC levels between ${lower.toFixed(2)} and ${upper.toFixed(2)} | base spacing ${baseSpacing.toFixed(6)} (ratio ${geomRatio}) | budget ${budget.toFixed(2)} USDT x${gc.leverage}`)
  // Geometric spacing applied successfully.
}

export async function teardownGrid(cfg: BotConfig, currentPrice: number | null): Promise<void> {
  const active = await getActiveOrders(cfg.symbol, cfg.timeframe)

  // Resolve a real exchange client only in live mode so held inventory is
  // liquidated on MEXC during a manual Stop. Previously `exchange` was
  // referenced here but never defined — a ReferenceError that made Stop throw
  // and leave real positions open.
  const exchange: ExchangeClient | undefined =
    cfg.mode === "live" ? getExchangeClient(cfg.exchange as Exchange) : undefined

  // Maker: cancel real resting orders on the exchange first so we never leave
  // orphaned post-only orders behind after a manual stop.
  const makerIds = active.filter((o) => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
  if (makerIds.length > 0 && exchange) {
    try {
      await exchange.cancelOrders(makerIds)
      await log("info", `Grid teardown: cancelled ${makerIds.length} resting maker orders on exchange`)
    } catch (err) {
      await log("error", `Grid teardown: failed cancelling maker orders: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  // Liquidate held inventory (filled buys awaiting sells) at market
  const holding = active.filter((o) => o.side === "sell")
  for (const o of holding) {
    if (currentPrice != null && o.buyPrice != null) {
      await settleGridSell(o, currentPrice, cfg, "manual", exchange)
    }
  }

  const remaining = active.filter((o) => o.side === "buy").map((o) => o.id)
  if (remaining.length > 0) {
    await log("info", `[CancelOp] Line ~341: Cancelling orders`).catch(() => {});
  await db.update(gridOrders).set({ status: "cancelled" }).where(inArray(gridOrders.id, remaining))
  }

  await db
    .update(botConfig)
    .set({
      gridCenter: null,
      gridLower: null,
      gridUpper: null,
      gridSpacing: null,
      gridEffectiveLevels: null,
      gridPaused: false,
    })
    .where(eq(botConfig.id, 1))

  await log("info", "Grid torn down — pending buys cancelled, held inventory liquidated")
}

async function settleGridSell(
  order: GridOrder,
  exitPrice: number,
  cfg: BotConfig,
  reason: "tp" | "manual",
  exchange?: ExchangeClient
): Promise<boolean> {
  // DEFENSIVE GUARD: a naked sell (no buyPrice) is a short-open, never a
  // long-close. Refuse to book a phantom zero-PnL long if any future path
  // reaches here without a buyPrice.
  if (order.buyPrice == null) {
    await log("error", `Grid ${order.symbol}: settleGridSell called on naked sell (no buyPrice) — refusing to book phantom long`)
    return false
  }

  // ATOMIC CLAIM: only one concurrent caller can ever win this update (only
  // succeeds if the row is still "pending"). Without this, overlapping
  // triggers (duplicate WS events, overlapping ticks, or old/new instances
  // briefly running side by side during a deploy) can all process the same
  // fill, producing duplicate trade records and, in live mode, duplicate
  // real market orders for a single position.
  const claimed = await db.update(gridOrders)
    .set({ status: "filled", filledAt: sql`NOW()` })
    .where(and(eq(gridOrders.id, order.id), eq(gridOrders.status, "pending")))
    .returning({ id: gridOrders.id })
  if (claimed.length === 0) return false // another process already claimed this fill

  if (cfg.mode === "live") {
    try {
      if (exchange) { await exchange.placeMarketOrder({ symbol: order.symbol, side: 4, volume: order.quantity, leverage: order.leverage }) }
    } catch (err) {
      await log("error", `LIVE grid sell failed: ${err instanceof Error ? err.message : String(err)}`)
      // Real sell failed on the exchange. Revert the claim so a later,
      // legitimate retry can still process this fill.
      await db.update(gridOrders).set({ status: "pending" }).where(eq(gridOrders.id, order.id))
      // Real sell failed on the exchange (e.g. position already closed
      // manually, or a transient API error). The caller must NOT re-arm a
      // fresh buy in this case — that was silently happening before and
      // caused the same doomed retry every single tick.
      return false
    }
  }

  const buyPrice = order.buyPrice ?? order.price
  const sizeUsdt = buyPrice * order.quantity
  const grossPnl = (exitPrice - buyPrice) * order.quantity
  const { takerFeeRate: sgsRate } = getFeeRates(cfg.exchange as Exchange, order.symbol)
  const buyFee = buyPrice * order.quantity * sgsRate
  const sellFee = exitPrice * order.quantity * sgsRate
  const fees = buyFee + sellFee
  const netPnl = grossPnl - fees

  const [trade] = await db
    .insert(trades)
    .values({
      symbol: order.symbol,
      side: "long",
      entryPrice: buyPrice,
      exitPrice,
      sizeUsdt,
      leverage: order.leverage,
      pnl: netPnl,
      fees,
      exitReason: reason,
      strategy: "grid",
      live: cfg.mode === "live",
    })
    .returning({ id: trades.id })

  // Order already marked as filled during atomic claim above

  // Add net PnL (gross minus BOTH buy and sell fees). The buy fee is NOT
  // deducted at fill time, so it must be accounted for here.
  if (cfg.mode === "paper") {
    await db
      .update(botConfig)
      .set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` })
      .where(eq(botConfig.id, 1))
  }

  if (trade && order.entryFeatures) {
    try {
      const model = await loadModelFor("grid")
      await trainOnTrade(
        model,
        order.entryFeatures as unknown as FeatureVector,
        netPnl > 0,
        sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0,
        cfg.mlLearningRate,
        trade.id,
        null,
        MODEL_IDS.grid,
      )
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log(
    "trade",
    `Grid sell filled @ ${exitPrice.toFixed(2)} (bought ${buyPrice.toFixed(2)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`,
  )
  return true
}

// Maker settle: the resting post-only sell already executed on the exchange,
// so we do NOT place any order here — we only record the trade and books.
async function settleMakerSell(order: GridOrder, exitPrice: number, cfg: BotConfig): Promise<void> {
  // ATOMIC CLAIM: Prevent duplicate settlement
  const claimed = await db.update(gridOrders)
    .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
    .where(and(eq(gridOrders.id, order.id), eq(gridOrders.status, "pending")))
    .returning({ id: gridOrders.id })
  
  if (claimed.length === 0) return // Already claimed by another process

  const buyPrice = order.buyPrice ?? order.price
  const sizeUsdt = buyPrice * order.quantity
  const grossPnl = (exitPrice - buyPrice) * order.quantity
  // Both legs were resting post-only (maker) fills in this settlement path.
  const { makerFeeRate: smsRate } = getFeeRates(cfg.exchange as Exchange, order.symbol)
  const buyFee = buyPrice * order.quantity * smsRate
  const sellFee = exitPrice * order.quantity * smsRate
  const fees = buyFee + sellFee
  const netPnl = grossPnl - fees

  const [trade] = await db
    .insert(trades)
    .values({
      symbol: order.symbol,
      side: "long",
      entryPrice: buyPrice,
      exitPrice,
      sizeUsdt,
      leverage: order.leverage,
      pnl: netPnl,
      fees,
      exitReason: "tp",
      strategy: "grid",
      live: cfg.mode === "live",
    })
    .returning({ id: trades.id })

  // Order already marked as filled during atomic claim

  if (cfg.mode === "paper") {
    await db
      .update(botConfig)
      .set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` })
      .where(eq(botConfig.id, 1))
  }

  if (trade && order.entryFeatures) {
    try {
      const model = await loadModelFor("grid")
      await trainOnTrade(
        model,
        order.entryFeatures as unknown as FeatureVector,
        netPnl > 0,
        sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0,
        cfg.mlLearningRate,
        trade.id,
        null,
        MODEL_IDS.grid,
      )
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log(
    "trade",
    `Grid ${order.symbol} (maker) sell filled @ ${exitPrice.toFixed(6)} (bought ${buyPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`,
  )
}

// Maker tick: fills are detected from REAL MEXC order status, not price
// crossing. v1 intentionally omits auto-pause and auto-recenter — watch it.
async function settleMakerStopLoss(order: GridOrder, exitPrice: number, cfg: BotConfig, reason: "stop-loss" | "max-hold"): Promise<void> {
  if (reason === "stop-loss") await markPostStopCooldown(order.symbol).catch(() => {})
  // PAPER MODE: no real position exists on the exchange, so skip the exchange
  // round-trip entirely and settle locally. Hitting the exchange here would
  // always return 2009 "Position is nonexistent" and loop forever.
  if (cfg.mode !== "paper") {
    const client = getExchangeClient(cfg.exchange as Exchange)
    if (order.mexcOrderId) {
      try {
        await client.cancelOrders([order.mexcOrderId])
      } catch (err) {
        await log("error", `Grid ${order.symbol} (maker): failed cancelling resting sell before ${reason}: ${dbErr(err)}`)
      }
    }
    try {
      await client.placeMarketOrder({ symbol: order.symbol, side: 4, volume: order.quantity, leverage: order.leverage })
    } catch (err) {
      const errMsg = dbErr(err)
      if (errMsg.includes("2009") || errMsg.includes("nonexistent")) {
        await log("info", `Grid ${order.symbol} (maker): ${reason} close — position already gone on exchange (2009), reconciling local state`)
      } else {
        await log("error", `Grid ${order.symbol} (maker): ${reason} market close FAILED, will retry next tick: ${errMsg}`)
        return
      }
    }
  }

  const buyPrice = order.buyPrice ?? order.price
  const sizeUsdt = buyPrice * order.quantity
  const grossPnl = (exitPrice - buyPrice) * order.quantity
  // Entry was a resting post-only (maker) buy fill; this exit is a forced
  // market order (stop-loss/max-hold), which always crosses as taker.
  const { makerFeeRate: mslMaker, takerFeeRate: mslTaker } = getFeeRates(cfg.exchange as Exchange, order.symbol)
  const buyFee = buyPrice * order.quantity * mslMaker
  const sellFee = exitPrice * order.quantity * mslTaker
  const fees = buyFee + sellFee
  const netPnl = grossPnl - fees

  const [trade] = await db
    .insert(trades)
    .values({
      symbol: order.symbol, side: "long", entryPrice: buyPrice, exitPrice,
      sizeUsdt, leverage: order.leverage, pnl: netPnl, fees,
      exitReason: reason, strategy: "grid",
      live: cfg.mode === "live",
    })
    .returning({ id: trades.id })

  await db.update(gridOrders).set({ status: "filled", exchangeStatus: "cancelled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, order.id))
  if (cfg.mode === "paper") {
    await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
  }

  if (trade && order.entryFeatures) {
    try {
      // CRITICAL for self-learning: previously loss closes (stop-loss/max-hold)
      // did NOT train, so the grid model only ever saw winning TP fills and could
      // never learn to avoid bad entries. Train the grid model on this outcome.
      const model = await loadModelFor("grid")
      await trainOnTrade(
        model,
        order.entryFeatures as unknown as FeatureVector,
        netPnl > 0,
        sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0,
        cfg.mlLearningRate,
        trade.id,
        null,
        MODEL_IDS.grid,
      )
    } catch (err) {
      await log("error", `Grid ML update failed: ${err instanceof Error ? err.message : String(err)}`)
    }
  }

  await log("trade", `Grid ${order.symbol} (maker) ${reason.toUpperCase()} closed @ ${exitPrice.toFixed(6)} (bought ${buyPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
}

// Maker SHORT stop-loss settlement: cancel resting buy-to-close, then close short at market.
async function settleMakerShortStopLoss(order: GridOrder, exitPrice: number, cfg: BotConfig, reason: "stop-loss" | "max-hold"): Promise<void> {
  if (reason === "stop-loss") await markPostStopCooldown(order.symbol).catch(() => {})
// PAPER MODE: no real position exists on the exchange, so skip the exchange
// round-trip entirely and settle locally. Hitting the exchange here would
// always return 2009 "Position is nonexistent" and loop forever.
if (cfg.mode !== "paper") {
  const client = getExchangeClient(cfg.exchange as Exchange)
  if (order.mexcOrderId) {
    try {
      await client.cancelOrders([order.mexcOrderId])
    } catch (err) {
      await log("error", `Grid ${order.symbol} (maker short): failed cancelling resting buy before ${reason}: ${dbErr(err)}`)
    }
  }
  try {
    await client.placeMarketOrder({ symbol: order.symbol, side: 2, volume: order.quantity, leverage: order.leverage })
  } catch (err) {
    const errMsg = dbErr(err)
    if (errMsg.includes("2009") || errMsg.includes("nonexistent")) {
      await log("info", `Grid ${order.symbol} (maker short): ${reason} close — position already gone on exchange (2009), reconciling local state`)
    } else {
      await log("error", `Grid ${order.symbol} (maker short): ${reason} market close FAILED, will retry next tick: ${errMsg}`)
      return
    }
  }
}
const entryPrice = order.buyPrice ?? order.price
const sizeUsdt = entryPrice * order.quantity
const grossPnl = (entryPrice - exitPrice) * order.quantity
// Entry was a resting post-only (maker) sell fill (short open); this exit is
// a forced market order (stop-loss/max-hold), which always crosses as taker.
const { makerFeeRate: mssMaker, takerFeeRate: mssTaker } = getFeeRates(cfg.exchange as Exchange, order.symbol)
const fees = (entryPrice * mssMaker + exitPrice * mssTaker) * order.quantity
const netPnl = grossPnl - fees
const [trade] = await db
.insert(trades)
.values({
symbol: order.symbol, side: "short", entryPrice, exitPrice,
sizeUsdt, leverage: order.leverage, pnl: netPnl, fees,
exitReason: reason, strategy: "grid", live: cfg.mode === "live",
})
.returning({ id: trades.id })
await db.update(gridOrders).set({ status: "filled", exchangeStatus: "cancelled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, order.id))
if (cfg.mode === "paper") {
  await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
}
if (trade && order.entryFeatures) {
try {
// Train the grid model on this short loss/close too (see long path above):
// learning only from wins was starving the model of the losses it most
// needs to learn from.
const model = await loadModelFor("grid")
await trainOnTrade(
  model,
  order.entryFeatures as unknown as FeatureVector,
  netPnl > 0,
  sizeUsdt > 0 ? (netPnl / sizeUsdt) * 100 : 0,
  cfg.mlLearningRate,
  trade.id,
  null,
  MODEL_IDS.grid,
)
} catch (err) {
await log("error", `Grid ${order.symbol} (maker short) ML update failed: ${dbErr(err)}`)
}
}
await log("trade", `Grid ${order.symbol} (maker short) ${reason.toUpperCase()} closed @ ${exitPrice.toFixed(6)} (shorted ${entryPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
}

// Fast, symbol-agnostic risk check for ALL held positions (long and
// short), independent of candle-close cadence. Long holdings were
// previously only checked once per candle close (up to 15 min late,
// observed losses running 4-12x past the intended 4% cap). Short
// holdings had NO periodic check at all -- settleMakerShortStopLoss
// existed but was only ever called incidentally during grid recenters.
// This function is meant to be called on a short interval (e.g. every
// 15-20s) from instrumentation.ts, using the already-live in-memory
// livePrices instead of an extra REST call per symbol.
export async function checkAllHeldPositionsRisk(): Promise<void> {
  const cfgRows = await db.select().from(botConfig).where(eq(botConfig.id, 1)).limit(1)
  const cfg = cfgRows[0]
  if (!cfg) return

  // Regime-aware max-hold: read each grid's persisted pause state so a
  // trending pair (auto-paused) cuts losers fast instead of waiting 4h.
  const gridRows = await db.select().from(gridConfigs)
  const pausedBySymbol = new Map<string, boolean>()
  for (const g of gridRows) pausedBySymbol.set(g.symbol, g.paused)

  const held = await db.select().from(gridOrders).where(
    and(eq(gridOrders.status, "pending"), isNotNull(gridOrders.buyPrice))
  )

  for (const o of held) {
    const currentPrice = livePrices[o.symbol]
    if (!currentPrice || currentPrice <= 0) continue
    const entryPrice = o.buyPrice as number
    const heldMinutes = o.createdAt ? (Date.now() - new Date(o.createdAt as any).getTime()) / 60000 : 0

    if (o.side === "sell") {
      // Held long: loses when price falls below entry.
      const adverseMove = (currentPrice - entryPrice) / entryPrice
      if (o.slPrice != null ? currentPrice <= o.slPrice : adverseMove <= -effectiveMakerStopPct(o.leverage)) {
        await log("info", `Grid ${o.symbol} (maker, fast-check): stop-loss triggered — price ${currentPrice.toFixed(6)} is ${(adverseMove * 100).toFixed(2)}% below entry ${entryPrice.toFixed(6)} (sl ${o.slPrice?.toFixed(6) ?? "pct"})`)
        await settleMakerStopLoss(o, currentPrice, cfg, "stop-loss")
      } else if (heldMinutes >= (pausedBySymbol.get(o.symbol) ? TREND_MAX_HOLD_MINUTES : MAKER_MAX_HOLD_MINUTES)) {
        await log("info", `Grid ${o.symbol} (maker, fast-check): max-hold triggered — held ${heldMinutes.toFixed(0)}m, closing at market`)
        await settleMakerStopLoss(o, currentPrice, cfg, "max-hold")
      }
    } else if (o.side === "buy") {
      // Held short: loses when price rises above entry.
      const adverseMove = (currentPrice - entryPrice) / entryPrice
      if (o.slPrice != null ? currentPrice >= o.slPrice : adverseMove >= effectiveMakerStopPct(o.leverage)) {
        await log("info", `Grid ${o.symbol} (maker, fast-check): short stop-loss triggered — price ${currentPrice.toFixed(6)} is ${(adverseMove * 100).toFixed(2)}% above entry ${entryPrice.toFixed(6)} (sl ${o.slPrice?.toFixed(6) ?? "pct"})`)
        await settleMakerShortStopLoss(o, currentPrice, cfg, "stop-loss")
      } else if (heldMinutes >= (pausedBySymbol.get(o.symbol) ? TREND_MAX_HOLD_MINUTES : MAKER_MAX_HOLD_MINUTES)) {
        await log("info", `Grid ${o.symbol} (maker, fast-check): short max-hold triggered — held ${heldMinutes.toFixed(0)}m, closing at market`)
        await settleMakerShortStopLoss(o, currentPrice, cfg, "max-hold")
      }
    }
  }
}

async function runGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange: ExchangeClient): Promise<void> {
  if (gc.direction === "short" || (gc as any)._autoSide === "short") { return handleShortGridTickMaker(cfg, gc, snap, regime, exchange) }
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  // ── Adaptive flow gate: resolve shadow positions + periodic kill-switch ──
  await resolveShadowEntries(gc.symbol, snap.price)
  await evaluateKillSwitch(gc.symbol)
  const volatility = detectVolatilitySurge(gc.symbol, snap)
  const gridAdxThreshold = 32 // Grids handle mild trends better than single positions
const paused = gc.autoPause && snap.adx >= gridAdxThreshold

  const gridConfigRow = await db.select().from(gridConfigs).where(
    and(eq(gridConfigs.symbol, gc.symbol), eq(gridConfigs.timeframe, gc.timeframe))
  ).limit(1)

  if (gridConfigRow.length > 0 && gridConfigRow[0].paused !== paused) {
    await db.update(gridConfigs).set({ paused }).where(eq(gridConfigs.id, gridConfigRow[0].id))
    if (paused) {
      const restingBuys = active.filter((o) => o.side === "buy")
      if (restingBuys.length > 0) {
        try {
          const liveIds = restingBuys.filter(o => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
          if (liveIds.length > 0) await exchange.cancelOrders(liveIds)
          await db.update(gridOrders)
            .set({ status: "cancelled", exchangeStatus: "cancelled" })
            .where(inArray(gridOrders.id, restingBuys.map((o) => o.id)))
          await log("info", `Grid ${gc.symbol} (maker): trend detected — cancelled ${restingBuys.length} resting buy(s) on exchange`)
        } catch (err) {
          await log("error", `Grid ${gc.symbol} (maker): trend detected but failed cancelling resting buys: ${dbErr(err)}`)
        }
      } else {
        await log("info", `Grid ${gc.symbol} (maker): trend detected — auto-paused, no resting buys to cancel`)
      }
    } else {
      await log("info", `Grid ${gc.symbol} (maker): ranging conditions restored — resuming buy ladder`)
    }
    active = await getActiveOrders(gc.symbol, gc.timeframe)
  }

  if (active.length === 0) {
    if (!gc.enabled) return
    if (paused) return
    // ── Adaptive flow gate: block new entries when trailing 6h PnL < 0 ──
    if (await shouldGateEntry(gc.symbol)) {
      await recordShadowEntry({
        symbol: gc.symbol,
        side: "long",
        entryPrice: snap.price,
        quantity: 1,
        leverage: gc.leverage,
        tpPrice: snap.price + snap.atr * gc.rangeAtrMult,
        slPrice: snap.price * (1 - effectiveGridStopPct(gc.leverage)),
      })
      await log("info", `Grid ${gc.symbol} (maker): flow gate active (6h PnL < 0) — skipping new entries`)
      return
    }
    await log("info", `Grid ${gc.symbol} (maker): setting up fresh resting ladder`)
    await setupGrid(cfg, gc, snap, volatility, undefined, true)
    return
  }

  // Auto-recenter: cancel stale resting buys and rebuild near current price
  // if the market has moved too far away for them to realistically fill.
  if (!paused) {
    const restingBuys = active.filter((o) => o.side === "buy" && o.mexcOrderId)
    if (restingBuys.length > 0) {
      let livePrice: number | null = null
      try {
        livePrice = (await getExchangeClient(cfg.exchange).fetchTicker(gc.symbol)).lastPrice
      } catch {}
      if (livePrice != null) {
        const minDrift = Math.min(...restingBuys.map((o) => Math.abs(livePrice! - o.price) / livePrice!))
        if (minDrift > MAKER_RECENTER_DRIFT_PCT) {
          await log("info", `Grid ${gc.symbol} (maker): price drifted ${(minDrift * 100).toFixed(1)}% from resting buys. Recentering at ${livePrice.toFixed(6)}.`)
          try {
            const toCancel = (gc.direction as string) === "neutral" ? active : restingBuys
            // SAFETY: never cancel an order that represents a real held
            // position (buyPrice set — a filled buy awaiting its sell, or
            // a filled sell awaiting its buy-to-close) without closing it
            // at market first. Cancelling it outright here is exactly how
            // APR_USDT became a real, untracked, unprotected exchange
            // position after a recenter.
            const held = toCancel.filter((o) => o.buyPrice != null)
            const naked = toCancel.filter((o) => o.buyPrice == null)
            for (const o of held) {
              await log("info", `Grid ${gc.symbol} (maker): recenter closing held ${o.side} @ ${o.price.toFixed(6)} (entry ${o.buyPrice!.toFixed(6)}) at market before rebuild`)
              if (o.side === "sell") {
                await settleMakerStopLoss(o, livePrice!, cfg, "max-hold")
              } else {
                await settleMakerShortStopLoss(o, livePrice!, cfg, "max-hold")
              }
            }
            const liveIds = naked.filter(o => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
            if (liveIds.length > 0) await exchange.cancelOrders(liveIds)
            if (naked.length > 0) {
              await db.update(gridOrders)
                .set({ status: "cancelled", exchangeStatus: "cancelled" })
                .where(inArray(gridOrders.id, naked.map((o) => o.id)))
            }
            await setupGrid(cfg, gc, snap, volatility, undefined, true)
          } catch (err) {
            await log("error", `Grid ${gc.symbol} (maker): recenter failed: ${dbErr(err)}`)
          }
          return
        }
      }
    }
  }

  const spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult

  // Poll resting BUY orders for real fills
  const buys = active.filter((o) => o.side === "buy" && o.mexcOrderId)
  for (const o of buys) {
    const st: any = await exchange.fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    const state = Number(st.state)
    if (state === 3) {
      const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      // COMBO SHORT CLOSE: a buy with buyPrice set is a buy-to-close that
      // just filled — the short is now closed. Record the short close and
      // re-arm a fresh naked sell at the original short entry level.
      if (o.buyPrice != null) {
        const entryPrice = o.buyPrice
        const grossPnl = (entryPrice - fillPrice) * o.quantity
        const { makerFeeRate: scRate } = getFeeRates(cfg.exchange as Exchange, o.symbol)
        const fees = (entryPrice + fillPrice) * o.quantity * scRate
        const netPnl = grossPnl - fees
        const sizeUsdt = entryPrice * o.quantity
        await db.update(gridOrders)
          .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
          .where(eq(gridOrders.id, o.id))
        await db.insert(trades).values({
          symbol: o.symbol, side: "short", entryPrice, exitPrice: fillPrice,
          sizeUsdt, leverage: o.leverage, pnl: netPnl, fees,
          exitReason: "tp", strategy: "grid", live: cfg.mode === "live",
        })
        if (cfg.mode === "paper") {
          await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
        }
        await log("trade", `Grid ${o.symbol} (maker) COMBO short closed @ ${fillPrice.toFixed(6)} (shorted ${entryPrice.toFixed(6)}) | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
        // Re-arm a fresh naked sell at the original short entry level
        if (!paused) {
          try {
            const res: any = await placeRoundedMakerOrder(o.symbol, 3, entryPrice, o.quantity, o.leverage, exchange)
            const sid = extractOrderId(res)
            await db.insert(gridOrders).values({
              symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
              spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell",
              price: entryPrice, quantity: o.quantity,
              mexcOrderId: sid, exchangeStatus: "new", status: "pending",
            })
          } catch (err) {
            await log("error", `Grid ${o.symbol} (maker): re-arm short failed @ ${entryPrice.toFixed(6)}: ${dbErr(err)}`)
          }
        }
        continue
      }
      await db
        .update(gridOrders)
        .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
        .where(eq(gridOrders.id, o.id))
      const buyFee = fillPrice * o.quantity * getFeeRates(cfg.exchange as Exchange, o.symbol).makerFeeRate
      await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance}` /* MARGIN DEDUCTION REMOVED FOR PAPER TRADING */ }).where(eq(botConfig.id, 1))

      const sellPrice = fillPrice + (snap.atr * gc.rangeAtrMult)
      try {
        const res: any = await placeRoundedMakerOrder(o.symbol, 4, sellPrice, o.quantity, o.leverage, exchange)
              const sid = extractOrderId(res)
        await db.insert(gridOrders).values({
          symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
          spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell",
          price: sellPrice, quantity: o.quantity, buyPrice: fillPrice,
          entryFeatures: { ...snap.features, sideLong: 1 },
          mexcOrderId: sid, exchangeStatus: "new", status: "pending",
        })
        await log("trade", `Grid ${o.symbol} (maker) buy filled @ ${fillPrice.toFixed(6)} | resting sell @ ${sellPrice.toFixed(6)}`)
      } catch (err) {
              await log("error", `Grid ${o.symbol} (maker): sell placement failed @ ${sellPrice.toFixed(6)}: ${dbErr(err)}`)
      }
    } else if (state === 4 || state === 5) {
      await db.update(gridOrders).set({ status: "cancelled", exchangeStatus: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }

  // Poll resting SELL orders for real fills
  const sells = active.filter((o) => o.side === "sell" && o.mexcOrderId)
  for (const o of sells) {
    const st: any = await exchange.fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    const state = Number(st.state)
    if (state === 3) {
      const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      // COMBO SHORT OPEN: a naked sell (no buyPrice) filling means we just
      // opened a short. Place a buy-to-close TP one spacing below entry.
      if (o.buyPrice == null) {
        await db.update(gridOrders)
          .set({ status: "filled", exchangeStatus: "filled", filledAt: sql`NOW()` })
          .where(eq(gridOrders.id, o.id))
        const closePrice = fillPrice - (snap.atr * gc.rangeAtrMult)
        try {
          const res: any = await placeRoundedMakerOrder(o.symbol, 2, closePrice, o.quantity, o.leverage, exchange)
          const bid = extractOrderId(res)
          await db.insert(gridOrders).values({
            symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
            spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy",
            price: closePrice, quantity: o.quantity, buyPrice: fillPrice,
            entryFeatures: { ...snap.features, sideLong: -1 },
            mexcOrderId: bid, exchangeStatus: "new", status: "pending",
          })
          await log("trade", `Grid ${o.symbol} (maker) COMBO short opened @ ${fillPrice.toFixed(6)} | buy-to-close @ ${closePrice.toFixed(6)}`)
        } catch (err) {
          await log("error", `Grid ${o.symbol} (maker): buy-to-close placement failed @ ${closePrice.toFixed(6)}: ${dbErr(err)}`)
        }
        continue
      }
      const exitPrice = fillPrice
      await settleMakerSell(o, exitPrice, cfg)
      // Re-arm a resting maker buy back at the original level
      if (o.buyPrice != null && !paused) {
        try {
          const res: any = await placeRoundedMakerOrder(o.symbol, 1, o.buyPrice, o.quantity, o.leverage, exchange)
              const bid = extractOrderId(res)
          await db.insert(gridOrders).values({
            symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
            spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy",
            price: o.buyPrice, quantity: o.quantity,
            mexcOrderId: bid, exchangeStatus: "new", status: "pending",
          })
        } catch (err) {
              await log("error", `Grid ${o.symbol} (maker): re-arm buy failed @ ${o.buyPrice.toFixed(6)}: ${dbErr(err)}`)
        }
      }
    } else if (state === 4 || state === 5) {
      await db.update(gridOrders).set({ status: "cancelled", exchangeStatus: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }

  // Risk control: protect held inventory regardless of pause/regime state.
  const heldSells = active.filter((o) => o.side === "sell" && o.buyPrice != null && o.status === "pending")
  if (heldSells.length > 0) {
    let currentPrice: number | null = null
    try {
      currentPrice = (await getExchangeClient(cfg.exchange).fetchTicker(gc.symbol)).lastPrice
    } catch {}
    if (currentPrice != null) {
      for (const o of heldSells) {
        const buyPrice = o.buyPrice as number
        const adverseMove = (currentPrice - buyPrice) / buyPrice
        const heldMinutes = o.createdAt ? (Date.now() - new Date(o.createdAt as any).getTime()) / 60000 : 0
        if (adverseMove <= -effectiveMakerStopPct(o.leverage)) {
          await log("info", `Grid ${o.symbol} (maker): stop-loss triggered — price ${currentPrice.toFixed(6)} is ${(adverseMove * 100).toFixed(2)}% below entry ${buyPrice.toFixed(6)}`)
          await settleMakerStopLoss(o, currentPrice, cfg, "stop-loss")
        } else if (heldMinutes >= (paused ? TREND_MAX_HOLD_MINUTES : MAKER_MAX_HOLD_MINUTES)) {
          await log("info", `Grid ${o.symbol} (maker): max-hold triggered — held ${heldMinutes.toFixed(0)}m, closing at market`)
          await settleMakerStopLoss(o, currentPrice, cfg, "max-hold")
        }
      }
    }
  }
}

export async function runGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange?: ExchangeClient, candles?: Candle[]): Promise<void> {
  // Auto-direction: resolve the effective side from regime before any
  // branching so the build path and short-grid handlers see the same side.
  if (gc.direction === "auto") {
    const prev = (gc as any)._autoSide
    const next = resolveAutoSide(gc, snap, regime)
    ;(gc as any)._autoSide = next
    if (prev && prev !== next) {
      await log("info", `Grid ${gc.symbol}: auto-direction switched ${prev} → ${next} (regime ${regime})`)
    }
  }
  // Maker mode (live + enabled symbol): use the real-order polling path and
  // skip the entire virtual-fill engine below.
  if (cfg.mode === "live" && isMakerSymbol(gc)) {
    return runGridTickMaker(cfg, gc, snap, regime, exchange ?? getExchangeClient(cfg.exchange as Exchange))
  }

  const active = await getActiveOrders(gc.symbol, gc.timeframe)
  if (await checkGridStopLoss(cfg, gc, snap.price, exchange)) return
  // ── Adaptive flow gate: resolve shadow positions + periodic kill-switch ──
  await resolveShadowEntries(gc.symbol, snap.price)
  await evaluateKillSwitch(gc.symbol)
  if (gc.direction === "short" || (gc as any)._autoSide === "short") { return handleShortGridTick(cfg, gc, snap, exchange) }

  // Detect volatility surge for adaptive spacing
  const volatility = detectVolatilitySurge(gc.symbol, snap)

  // No active orders for this pair — set up a fresh ladder
  if (active.length === 0) {
    if (!gc.enabled) return
    // ── Adaptive flow gate: block new entries when trailing 6h PnL < 0 ──
    if (await shouldGateEntry(gc.symbol)) {
      await recordShadowEntry({
        symbol: gc.symbol,
        side: "long",
        entryPrice: snap.price,
        quantity: 1,
        leverage: gc.leverage,
        tpPrice: snap.price + snap.atr * gc.rangeAtrMult,
        slPrice: snap.price * (1 - effectiveGridStopPct(gc.leverage)),
      })
      await log("info", `Grid ${gc.symbol}: flow gate active (6h PnL < 0) — skipping new entries`)
      return
    }
    // ── Cross-strategy exposure gate for grid ──
    const gridNotional = (gc.budgetPct / 100) * cfg.paperBalance * gc.leverage
    const gridEquity = cfg.paperBalance || 1
    const gridDirection = gc.direction === "auto" ? "neutral" : gc.direction as "long" | "short"
    const gridExposure = await checkGridExposureGate(gc.symbol, gridDirection, gridNotional, gridEquity)
    if (!gridExposure.allowed) {
      await log("info", `Grid ${gc.symbol}: entry blocked by exposure gate: ${gridExposure.reason}`)
      return
    }

    // Track how many ticks the grid has been empty
    const emptyTicks = (gc as any)._emptyTicks || 0
    if (emptyTicks >= 2) {
      await log("info", `Grid ${gc.symbol}: force-rebuilding after ${emptyTicks} empty ticks`)
    }
    (gc as any)._emptyTicks = emptyTicks + 1
    await log("info", `Grid ${gc.symbol}: setting up fresh ladder`)
    await setupGrid(cfg, gc, snap, volatility, exchange, true)
    return
  }
  // Reset empty tick counter when orders exist
  ;(gc as any)._emptyTicks = 0

  // Use live ticker price for accurate fill detection
  let price = snap.price
  try {
    if (exchange) {
      const ticker = await exchange.fetchTicker(gc.symbol)
      if (ticker?.lastPrice) price = ticker.lastPrice
    }
  } catch (err) { /* use snap.price as fallback */ }
  if (!price || price <= 0) {
const sellPrices = active.filter(o => o.side === "sell").map(o => o.price)
if (sellPrices.length > 0) price = Math.max(...sellPrices) + 0.0001
}
let hi = price, lo = price
if (candles && candles.length > 0) {
const cur = candles[candles.length - 1] // forming candle: includes the current spike
hi = Math.max(price, cur.high)
lo = Math.min(price, cur.low)
}
  let spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
  const gridAdxThreshold = 32 // Grids handle mild trends better than single positions
const paused = gc.autoPause && snap.adx >= gridAdxThreshold
  
  // Phantom trend order removed

  // Update paused state in grid_configs
  const gridConfigRow = await db.select().from(gridConfigs).where(
    and(eq(gridConfigs.symbol, gc.symbol), eq(gridConfigs.timeframe, gc.timeframe))
  ).limit(1)
  
  if (gridConfigRow.length > 0 && gridConfigRow[0].paused !== paused) {
    await db.update(gridConfigs)
      .set({ paused })
      .where(eq(gridConfigs.id, gridConfigRow[0].id))
    await log("info", paused
      ? `Grid ${gc.symbol} auto-paused: trending regime detected. Sells remain active.`
      : `Grid ${gc.symbol} resumed: ranging conditions restored`)
  }

  // Auto-recenter: if price has drifted far, OR if Bollinger Bands have squeezed tighter, rebuild ladder
  const allPrices = active.map(o => o.price)
  if (allPrices.length > 0) {
    const minOrderPrice = Math.min(...allPrices)
    const maxOrderPrice = Math.max(...allPrices)
    const priceDrift = Math.min(
      Math.abs(price - minOrderPrice) / price * 100,
      Math.abs(price - maxOrderPrice) / price * 100
    )
    
    // Dynamic Bollinger Adjustment: If BB width is 40% narrower than our current spacing, rebuild tighter
    const currentBbWidth = snap.bbUpper - snap.bbLower
    const currentSpacing = active.find(o => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
    const needsTighten = false // Disabled: BB squeeze causes infinite cancel/rebuild loops in low vol

    // If price is >15% away, OR the grid is too wide for the current volatility
    // NEUTRAL DRIFT FIX: Only recenter if price escapes the ladder entirely
let shouldRecenter = false;
if ((gc as any).direction === "neutral") {
  const highestSell = active.filter(o => o.side === "sell").reduce((max, o) => Math.max(max, o.price), 0);
  const lowestBuy = active.filter(o => o.side === "buy").reduce((min, o) => Math.min(min, o.price), Infinity);
  shouldRecenter = price > highestSell * 1.02 || price < lowestBuy * 0.98;
} else {
  shouldRecenter = priceDrift > 15 || needsTighten;
}
if (shouldRecenter) {
      await log("info", `Grid ${gc.symbol}: price drifted ${priceDrift.toFixed(1)}% from orders. Recentering ladder at ${price.toFixed(4)}.`)
      // Cancel ALL pending orders — if price crashed >40%, sells are hopeless
      const cancelAll = shouldRecenter || (gc.direction as string) === "neutral" // COMBO-FIX: neutral rebuilds wipe both sides
      for (const o of active) {
        if (!(o.side === "buy" || cancelAll)) continue
        // SAFETY: an order with buyPrice set represents a real held
        // position (filled buy awaiting sell, or filled sell awaiting
        // buy-to-close). Close it at market before wiping it from
        // tracking — cancelling it outright here previously turned a
        // recenter into a silently abandoned, unprotected real position.
        if (o.buyPrice != null) {
          if (o.side === "sell") {
            await log("info", `Grid ${o.symbol}: recenter closing held long @ ${price.toFixed(6)} (entry ${o.buyPrice.toFixed(6)}) at market before rebuild`)
            await settleGridSell(o, price, cfg, "manual", exchange)
          } else {
            await log("info", `Grid ${o.symbol}: recenter closing held short @ ${price.toFixed(6)} (entry ${o.buyPrice.toFixed(6)}) at market before rebuild`)
            try {
              if (cfg.mode === "live" && exchange) {
                await exchange.placeMarketOrder({ symbol: o.symbol, side: 2, volume: o.quantity, leverage: o.leverage })
              }
            } catch (err) {
              await log("error", `Grid ${o.symbol}: recenter short close failed: ${err instanceof Error ? err.message : String(err)}`)
            }
            await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
          }
        } else {
          await log("info", `[CancelOp] Line ~891: Cancelling orders`).catch(() => {});
  await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
        }
      }
      // Rebuild buys at current price
      await setupGrid(cfg, gc, snap, volatility, exchange)
      return
    }
  }

  // 1) Sell fills: price rose to/above a pending sell level
  const sells = active.filter((o) => o.side === "sell" && hi >= o.price)
for (const o of sells) {
if (o.buyPrice == null) {
await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
const closePrice = o.price - spacing
await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, entryFeatures: { ...snap.features, sideLong: -1 }, status: "pending" })
await log("trade", `Grid ${o.symbol} COMBO short sell @ ${o.price.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
continue
}

const sold = await settleGridSell(o, o.price, cfg, "tp", exchange)
    // Re-arm the buy at its original level — only if the sell actually
    // succeeded. Re-arming after a failed sell (e.g. the position no longer
    // existed on the exchange) just recreates the same doomed order forever.
    if (sold && o.buyPrice != null) {
      await db.insert(gridOrders).values({
        symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
        spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy",
        price: o.buyPrice, quantity: o.quantity, status: "pending",
      })
    }
  }

  // 2) Buy fills: price dropped to/below a pending buy level (skip when paused)
  if (!paused) {
    const buys = active.filter((o) => o.side === "buy" && lo <= o.price)
for (const o of buys) {
if (o.buyPrice != null && (gc as any).direction === "neutral") {
  // COMBO: Create corresponding SELL order after buy fills
  const sellPrice = o.price + (o.spacing ?? 0) * gc.leverage; // TP at spacing distance
  await log("info", `Grid ${o.symbol}: COMBO buy filled, creating SELL @ ${sellPrice.toFixed(6)}`);
  // RACE-FIX: Re-check order status before processing (prevents double-fill)
  const fresh = await db.select({ status: gridOrders.status }).from(gridOrders).where(eq(gridOrders.id, o.id))
  if (fresh[0]?.status !== "pending") continue
  
  const entry = o.buyPrice
  const grossPnl = (entry - o.price) * o.quantity
  const fees = (entry + o.price) * o.quantity * getFeeRates(cfg.exchange as Exchange, o.symbol).makerFeeRate
  const netPnl = grossPnl - fees
  await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice: entry, exitPrice: o.price, sizeUsdt: entry * o.quantity, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: false })
await log("trade", `Grid ${o.symbol} COMBO short closed @ ${o.price.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell", price: entry, quantity: o.quantity, status: "pending" })
continue
}
// (dead/unreachable duplicate block removed -- identical condition to the
// block above, which already `continue`s on match, so this could never run)
if (cfg.mode === "live") {
        try {
          if (exchange) { await log("info", `LIVE buy: ${o.symbol} price=${o.price} qty=${o.quantity} lev=${o.leverage}`); await exchange.placeMarketOrder({ symbol: o.symbol, side: 1 as any, volume: o.quantity, leverage: o.leverage }) }
        } catch (err) {
          await log("error", `LIVE grid buy failed: ${err instanceof Error ? err.message : String(err)}`)
          continue
        }
      }

      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      const buyFee = o.price * o.quantity * getFeeRates(cfg.exchange as Exchange, o.symbol).takerFeeRate
      await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance}` /* MARGIN DEDUCTION REMOVED FOR PAPER TRADING */ }).where(eq(botConfig.id, 1))

      // Check the DATABASE for existing sells to prevent duplicates
      const existingSells = await db.select().from(gridOrders).where(
        and(
          eq(gridOrders.symbol, o.symbol),
          eq(gridOrders.side, "sell"),
          eq(gridOrders.buyPrice, o.price),
          eq(gridOrders.levelIndex, o.levelIndex),
          eq(gridOrders.status, "pending")
        )
      )
      if (existingSells.length > 0) continue
      
      await db.insert(gridOrders).values({
        symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage,
        spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell",
        price: o.price + spacing, quantity: o.quantity, buyPrice: o.price,
        // ON CONFLICT DO NOTHING handled by database unique index
        entryFeatures: { ...snap.features, sideLong: 1 },
        status: "pending",
      })

      await log("trade", `Grid ${o.symbol} buy @ ${o.price.toFixed(4)} | sell placed @ ${(o.price + (snap.atr * gc.rangeAtrMult)).toFixed(4)}`)
    }
  }
}


async function handleShortGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange: ExchangeClient): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  // ── Adaptive flow gate: resolve shadow positions + periodic kill-switch ──
  await resolveShadowEntries(gc.symbol, snap.price)
  await evaluateKillSwitch(gc.symbol)
  if (active.length === 0) {
    // ── Adaptive flow gate: block new short entries when trailing 6h PnL < 0 ──
    if (await shouldGateEntry(gc.symbol)) {
      await recordShadowEntry({
        symbol: gc.symbol,
        side: "short",
        entryPrice: snap.price,
        quantity: 1,
        leverage: gc.leverage,
        tpPrice: snap.price - snap.atr * gc.rangeAtrMult,
        slPrice: snap.price * (1 + effectiveGridStopPct(gc.leverage)),
      })
      await log("info", `Grid ${gc.symbol} (short maker): flow gate active (6h PnL < 0) — skipping new entries`)
      return
    }
    await setupGrid(cfg, gc, snap, undefined, undefined)
    return
  }
  const spacing = active.find((o) => o.spacing != null)?.spacing ?? snap.atr * gc.rangeAtrMult
  for (const o of active.filter(o => o.side === "sell" && o.mexcOrderId)) {
    const st: any = await exchange.fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    if (Number(st.state) === 3) {
      const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      const closePrice = fillPrice - (snap.atr * gc.rangeAtrMult)
      try {
        const res: any = await placeRoundedMakerOrder(o.symbol, 2, closePrice, o.quantity, o.leverage, exchange)
        const bid = extractOrderId(res)
        await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: fillPrice, mexcOrderId: bid, exchangeStatus: "new", status: "pending" })
        await log("trade", `Short ${o.symbol} sell filled @ ${fillPrice.toFixed(6)} | buy to close @ ${closePrice.toFixed(6)}`)
      } catch (err) {
        await log("error", `Short ${o.symbol} buy placement failed: ${dbErr(err)}`)
      }
    } else if ([4,5].includes(Number(st.state))) {
      await log("info", `[CancelOp] Line ~1025: Cancelling orders`).catch(() => {});
  await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }
  for (const o of active.filter(o => o.side === "buy" && o.mexcOrderId)) {
    const st: any = await exchange.fetchOrderStatus(o.mexcOrderId as string)
    if (!st) continue
    if (Number(st.state) === 3) {
      const exitPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
      const entryPrice = o.buyPrice ?? exitPrice
      const grossPnl = (entryPrice - exitPrice) * o.quantity
      const fees = (entryPrice + exitPrice) * o.quantity * getFeeRates(cfg.exchange as Exchange, o.symbol).makerFeeRate
      const netPnl = grossPnl - fees
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
      }
      await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice, exitPrice, sizeUsdt: entryPrice * o.quantity, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
      await log("trade", `Short ${o.symbol} closed @ ${exitPrice.toFixed(6)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
      try {
        const res: any = await placeRoundedMakerOrder(o.symbol, 3, entryPrice, o.quantity, o.leverage, exchange)
        const sid = extractOrderId(res)
        await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell", price: entryPrice, quantity: o.quantity, mexcOrderId: sid, exchangeStatus: "new", status: "pending" })
      } catch (err) {
        await log("error", `Short ${o.symbol} re-arm sell failed: ${dbErr(err)}`)
      }
    } else if ([4,5].includes(Number(st.state))) {
      await log("info", `[CancelOp] Line ~1051: Cancelling orders`).catch(() => {});
  await db.update(gridOrders).set({ status: "cancelled" }).where(eq(gridOrders.id, o.id))
    }
  }
  const pendingSells = (await getActiveOrders(gc.symbol, gc.timeframe)).filter(o => o.side === "sell")
  if (pendingSells.length === 0) {
    await setupGrid(cfg, gc, snap, undefined, undefined)
  }
}

async function handleShortGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, exchange?: ExchangeClient): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)
  if (active.length === 0) {
    // ── Adaptive flow gate: block new short entries when trailing 6h PnL < 0 ──
    if (await shouldGateEntry(gc.symbol)) {
      await recordShadowEntry({
        symbol: gc.symbol,
        side: "short",
        entryPrice: snap.price,
        quantity: 1,
        leverage: gc.leverage,
        tpPrice: snap.price - snap.atr * gc.rangeAtrMult,
        slPrice: snap.price * (1 + effectiveGridStopPct(gc.leverage)),
      })
      await log("info", `Grid ${gc.symbol} (short): flow gate active (6h PnL < 0) — skipping new entries`)
      return
    }
    await setupGrid(cfg, gc, snap, undefined, exchange)
    return
  }
  const spacing = active.find(o => o.spacing)?.spacing ?? snap.atr * gc.rangeAtrMult
  let price = snap.price
  try { if (exchange) { const t = await exchange.fetchTicker(gc.symbol); if (t?.lastPrice) price = t.lastPrice } } catch {}
  for (const o of active.filter(o => o.side === "sell")) {
    if (o.mexcOrderId) {
      const st: any = await client.fetchOrderStatus(o.mexcOrderId)
      if (st && Number(st.state) === 3) {
        const fillPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
        await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
        const closePrice = fillPrice - (snap.atr * gc.rangeAtrMult)
        if (cfg.mode === "live") {
          try {
            const res: any = await placeRoundedMakerOrder(o.symbol, 2, closePrice, o.quantity, o.leverage, client)
            const bid = extractOrderId(res)
            await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: fillPrice, mexcOrderId: bid, exchangeStatus: "new", status: "pending" })
          } catch (err) { await log("error", `Short buy close failed: ${dbErr(err)}`) }
        } else {
          await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, status: "pending" })
        }
        await log("trade", `Short ${o.symbol} sell filled @ ${fillPrice.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
      }
    } else if (price >= o.price) {
      if (cfg.mode === "live" && exchange) {
        try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 3, volume: o.quantity, leverage: o.leverage }) } catch (err) { await log("error", `Short open failed: ${dbErr(err)}`) }
      }
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      const closePrice = o.price - (snap.atr * gc.rangeAtrMult)
      await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "buy", price: closePrice, quantity: o.quantity, buyPrice: o.price, status: "pending" })
      await log("trade", `Short ${o.symbol} sell @ ${o.price.toFixed(4)} | buy to close @ ${closePrice.toFixed(4)}`)
    }
  }
  for (const o of active.filter(o => o.side === "buy")) {
    if (o.mexcOrderId) {
      const st: any = await client.fetchOrderStatus(o.mexcOrderId)
      if (st && Number(st.state) === 3) {
        const exitPrice = Number(st.dealAvgPrice) > 0 ? Number(st.dealAvgPrice) : o.price
        const entryPrice = o.buyPrice ?? exitPrice
        const grossPnl = (entryPrice - exitPrice) * o.quantity
        const fees = (entryPrice + exitPrice) * o.quantity * getFeeRates(cfg.exchange as Exchange, o.symbol).makerFeeRate
        const netPnl = grossPnl - fees
        await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
        if (cfg.mode === "paper") {
          await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
        }
        await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice, exitPrice, sizeUsdt: entryPrice * o.quantity, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
        await log("trade", `Short ${o.symbol} closed @ ${exitPrice.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
        const newSellPrice = entryPrice
        if (cfg.mode === "live") {
          try {
            const res: any = await placeRoundedMakerOrder(o.symbol, 3, newSellPrice, o.quantity, o.leverage, client)
            const sid = extractOrderId(res)
            await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell", price: newSellPrice, quantity: o.quantity, mexcOrderId: sid, exchangeStatus: "new", status: "pending" })
          } catch (err) { await log("error", `Short re-arm sell failed: ${dbErr(err)}`) }
        } else {
          await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell", price: newSellPrice, quantity: o.quantity, status: "pending" })
        }
      }
    } else if (price <= o.price) {
      const entryPrice = o.buyPrice ?? o.price
      if (cfg.mode === "live" && exchange) {
        try { await exchange.placeMarketOrder({ symbol: o.symbol, side: 2, volume: o.quantity, leverage: o.leverage }) } catch (err) { await log("error", `Short close failed: ${dbErr(err)}`) }
      }
      const grossPnl = (entryPrice - o.price) * o.quantity
      const { makerFeeRate: mixedMaker, takerFeeRate: mixedTaker } = getFeeRates(cfg.exchange as Exchange, o.symbol)
      // Mixed fill: entry leg was a maker sell, close leg is a taker buy.
      const fees = (entryPrice * mixedMaker + o.price * mixedTaker) * o.quantity
      const netPnl = grossPnl - fees
      await db.update(gridOrders).set({ status: "filled", filledAt: sql`NOW()` }).where(eq(gridOrders.id, o.id))
      if (cfg.mode === "paper") {
        await db.update(botConfig).set({ paperBalance: sql`${botConfig.paperBalance} + ${netPnl}` }).where(eq(botConfig.id, 1))
      }
      await db.insert(trades).values({ symbol: o.symbol, side: "short", entryPrice, exitPrice: o.price, sizeUsdt: entryPrice * o.quantity, leverage: o.leverage, pnl: netPnl, fees, exitReason: "tp", strategy: "grid", live: cfg.mode === "live" })
      await log("trade", `Short ${o.symbol} closed @ ${o.price.toFixed(4)} | PnL ${netPnl >= 0 ? "+" : ""}${netPnl.toFixed(2)} USDT`)
      const newSellPrice = entryPrice
      if (cfg.mode === "live") {
        try {
          const res: any = await placeRoundedMakerOrder(o.symbol, 3, newSellPrice, o.quantity, o.leverage, client)
          const sid = extractOrderId(res)
          await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell", price: newSellPrice, quantity: o.quantity, mexcOrderId: sid, exchangeStatus: "new", status: "pending" })
        } catch (err) { await log("error", `Short re-arm sell failed: ${dbErr(err)}`) }
      } else {
        await db.insert(gridOrders).values({ symbol: o.symbol, timeframe: o.timeframe, leverage: o.leverage, spacing: snap.atr * gc.rangeAtrMult, levelIndex: o.levelIndex, slPrice: o.slPrice, side: "sell", price: newSellPrice, quantity: o.quantity, status: "pending" })
      }
    }
  }
  const pendingSells = (await getActiveOrders(gc.symbol, gc.timeframe)).filter(o => o.side === "sell")
  if (pendingSells.length === 0) {
    await setupGrid(cfg, gc, snap, undefined, exchange)
  }
}
export async function gridUnrealizedPnl(currentPrice: number, symbol?: string, timeframe?: string): Promise<number> {
  let holding: GridOrder[]
  if (symbol && timeframe) {
    holding = await db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell"), eq(gridOrders.symbol, symbol), eq(gridOrders.timeframe, timeframe)))
  } else if (symbol) {
    holding = await db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell"), eq(gridOrders.symbol, symbol)))
  } else {
    holding = await db.select().from(gridOrders).where(and(eq(gridOrders.status, "pending"), eq(gridOrders.side, "sell")))
  }
  const longPnl = holding.reduce((acc, o) => acc + (currentPrice - (o.buyPrice ?? o.price)) * o.quantity, 0)
const act = await getActiveOrders(symbol, timeframe)
const shortPnl = act.filter(o => o.side === "buy" && o.buyPrice != null).reduce((acc, o) => acc + ((o.buyPrice ?? 0) - currentPrice) * o.quantity, 0)
return longPnl + shortPnl
}

// ── Orphaned position reconciliation ──
// A "naked" position on MEXC with no matching tracking record in the DB is a
// serious risk: the bot's exit logic only manages positions it finds in its
// own tables (gridOrders for grid positions, positions for trend/scalp). If a
// tracking order is ever dropped (pause/recenter/sync drift) while the real
// position stays open on MEXC, the position becomes unprotected and can run
// to liquidation. This step queries MEXC's real open positions and force-
// closes any that have no matching tracking record, so no position can ever
// be silently abandoned again.
export async function reconcileOrphanedPositions(): Promise<void> {
  try {
    // Gate: only sweep for orphans when the grid subsystem is enabled. When the
    // grid is OFF (sniper-only / manual trading mode), this account-wide sweep
    // would force-close manual trades the bot has no tracking record for.
    const cfgRows = await db
      .select({ gridEnabled: botConfig.gridEnabled, exchange: botConfig.exchange })
      .from(botConfig)
      .where(eq(botConfig.id, 1))
    if (!cfgRows[0]?.gridEnabled) {
      console.log("[Reconcile] gridEnabled=false — skipping orphan reconciliation (manual trading mode)")
      return
    }
    // Venue gate: this sweep is MEXC-specific (reads holdVol/positionType/openAvgPrice
    // and calls getMexcSpecAsync). Never run it on another venue — it would
    // force-close manual orders the bot has no tracking record for.
    if ((cfgRows[0]?.exchange ?? "mexc") !== "mexc") {
      console.log(`[Reconcile] exchange=${cfgRows[0]?.exchange} — skipping MEXC-only orphan reconciliation`)
      return
    }

    const exchange = getExchangeClient(cfgRows[0].exchange as Exchange)
    const openPositions = (await exchange.getOpenPositions()) as any[]
    console.log(`[Reconcile] Checking ${Array.isArray(openPositions) ? openPositions.length : 0} open MEXC position(s) for orphans`)
    if (!Array.isArray(openPositions) || openPositions.length === 0) return

    // Normalize a symbol to a canonical form (underscore, uppercase) so the
    // comparison is robust regardless of whether the DB stores "HYPE/USDT"
    // (slash) or "HYPE_USDT" (underscore). MEXC returns underscore format.
    const norm = (s: string) => s.replace(/\//g, "_").toUpperCase()

    // Tracked grid positions: pending sell (held long) or pending buy (held
    // short) with buyPrice set — buyPrice marks a real filled entry.
    const gridPending = await db.select().from(gridOrders).where(eq(gridOrders.status, "pending"))
    const gridHeld = gridPending.filter((o) => o.buyPrice != null)
    // Tracked trend/scalp positions.
    const trendOpen = await db.select().from(positions).where(eq(positions.status, "open"))

    for (const p of openPositions) {
      const symbol = norm(String(p.symbol ?? ""))
      const positionType = Number(p.positionType) // 1 = long, 2 = short
      const side = positionType === 1 ? "long" : "short"
      const holdVol = Number(p.holdVol ?? 0) // contracts
      if (!symbol || holdVol <= 0) continue

      const gridTracked = gridHeld.some(
        (o) =>
          norm(o.symbol) === symbol &&
          ((side === "long" && o.side === "sell") || (side === "short" && o.side === "buy"))
      )
      const trendTracked = trendOpen.some(
        (o) => norm(o.symbol) === symbol && o.side === side
      )
      if (gridTracked || trendTracked) continue

      // ORPHAN: no tracking record anywhere. Force-close at market.
      const spec = await getMexcSpecAsync(symbol, Number(p.openAvgPrice ?? 0))
      const coinQty = holdVol * spec.contractSize
      const closeSide = side === "long" ? 4 : 2
      await log(
        "error",
        `[Orphan] DETECTED naked ${side} on ${symbol} (${holdVol} contracts ≈ ${coinQty} coins) with no tracking record — force-closing at market`
      )
      try {
        await exchange.placeMarketOrder({
          symbol,
          side: closeSide as 1 | 2 | 3 | 4,
          volume: coinQty,
          leverage: Number(p.leverage ?? 1),
        })
        await log("info", `[Orphan] Closed naked ${side} on ${symbol} at market`)
      } catch (err) {
        await log(
          "error",
          `[Orphan] FAILED to close naked ${side} on ${symbol}: ${err instanceof Error ? err.message : String(err)}`
        )
      }
    }
  } catch (err) {
    console.error("[Orphan] Reconciliation failed:", err)
  }
}


export async function syncExchangeState() {
  try {
    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    const cfgRows = await db.select().from(botConfig).limit(1)
    const client = getExchangeClient((cfgRows[0]?.exchange as Exchange) ?? "mexc")
    console.log(`[Reconcile] Syncing state for ${configs.length} enabled pairs...`)
    
    for (const c of configs) {
      try {
        const dbOrders = await db.select().from(gridOrders).where(
          and(eq(gridOrders.symbol, c.symbol), eq(gridOrders.status, "pending"))
        )
        
        for (const dbOrder of dbOrders) {
          // Skip orders synced in the last 2 hours — trust MEXC open_orders
          if ((dbOrder as any).syncedAt) {
            const syncAge = Date.now() - new Date((dbOrder as any).syncedAt).getTime()
            if (syncAge < 2 * 60 * 60 * 1000) continue
          }
          // Skip orders created or updated in the last 10 minutes (grace period for synced orders)
          const orderAge = Date.now() - new Date(dbOrder.createdAt).getTime()
          if (orderAge < 10 * 60 * 1000) continue
          
          if (dbOrder.mexcOrderId) {
            try {
              const st: any = await client.fetchOrderStatus(dbOrder.mexcOrderId as string)
              if (st) {
                const state = Number(st.state)
                // MEXC States: 1=Unfilled, 2=PartiallyFilled, 3=Filled, 4=Cancelled
                if (state === 3 || state === 4) {
                  const newStatus = state === 3 ? "filled" : "cancelled"
                  // LOUD LOG: Alert that a mismatch was found and corrected
                  await log("error", `[Reconcile] DRIFT DETECTED: ${c.symbol} DB Order ${dbOrder.mexcOrderId} is ${newStatus} on MEXC but pending in DB. Auto-correcting.`)
                  await db.update(gridOrders).set({ 
                    status: newStatus, 
                    exchangeStatus: newStatus, 
                    filledAt: state === 3 ? sql`NOW()` : null 
                  }).where(eq(gridOrders.id, dbOrder.id))
                }
              }
            } catch (e) {
              // Silently skip individual order status failures to keep the loop moving
            }
            // 100ms delay to avoid rate limits during sync
            await new Promise(r => setTimeout(r, 500))
          }
        }
      } catch (e) {
        console.error(`[Reconcile] Failed for ${c.symbol}:`, e)
      }
    }
    console.log("[Reconcile] State sync complete.")
    await reconcileOrphanedPositions()
  } catch (e) {
    console.error("[Reconcile] Failed to sync exchange state:", e)
  }
}
