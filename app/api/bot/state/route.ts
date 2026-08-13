import { NextResponse } from "next/server"
import { db } from "@/lib/db"
import {
  botConfig, gridConfigs, positions, trades, equitySnapshots,
  botLogs, mlModel, gridOrders, classifierDecisions,
} from "@/lib/db/schema"
import { eq, desc } from "drizzle-orm"
import { fetchTicker, fetchKlines } from "@/lib/mexc/public"
import { getAccountAssets } from "@/lib/mexc/private"
import { ema, computeSnapshot } from "@/lib/indicators"
import { detectRegime, type Regime } from "@/lib/strategy"
import { getGridConfigs, gridUnrealizedPnl } from "@/lib/grid"
import { isRotationEnabled, getLastRotationTime } from "@/lib/portfolio-rotator"
import { getShadowStats } from "@/lib/shadow-evaluator"

interface MexcAsset {
  currency: string; availableBalance: number; equity: number;
  unrealized: number; positionMargin: number; frozenBalance: number;
}

async function fetchLiveAccount() {
  if (!process.env.MEXC_API_KEY || !process.env.MEXC_API_SECRET) return null
  try {
    const assets = (await getAccountAssets()) as MexcAsset[]
    const usdt = Array.isArray(assets) ? assets.find((a) => a.currency === "USDT") : null
    if (!usdt) return { error: "No USDT asset found" }
    return { availableBalance: usdt.availableBalance, equity: usdt.equity, unrealized: usdt.unrealized, positionMargin: usdt.positionMargin }
  } catch (err) {
    return { error: err instanceof Error ? err.message : "Failed to fetch live account" }
  }
}

export const dynamic = "force-dynamic"
let lastShadowRun = 0

export async function GET() {
  const nowMs = Date.now()
  if (nowMs - lastShadowRun > 60_000) {
    lastShadowRun = nowMs
    runShadowCycle().catch(() => {})
  }
  let shadowStats: any = null
  try {
    shadowStats = await getShadowStats()
  } catch {
    shadowStats = { totalEvaluations: 0, resolvedCount: 0, correctCount: 0, accuracy: 0, topCandidate: null }
  }
  try {
    const [cfgRows, openPosRows, recentTrades, equity, logs, modelRows, activeGridOrders, decisions, gridConfigRows, lifetimeTradesRaw] = await Promise.all([
      db.select().from(botConfig).where(eq(botConfig.id, 1)),
      db.select().from(positions).where(eq(positions.status, "open")),
      db.select().from(trades).orderBy(desc(trades.closedAt)).limit(50),
      db.select().from(equitySnapshots).orderBy(desc(equitySnapshots.createdAt)).limit(200),
      db.select().from(botLogs).orderBy(desc(botLogs.createdAt)).limit(50),
      db.select().from(mlModel).where(eq(mlModel.id, 1)),
      db.select().from(gridOrders).where(eq(gridOrders.status, "pending")).orderBy(desc(gridOrders.price)),
      db.select().from(classifierDecisions).orderBy(desc(classifierDecisions.createdAt)).limit(100),
      db.select().from(gridConfigs).orderBy(gridConfigs.symbol),
      db.select({ pnl: trades.pnl, live: trades.live }).from(trades),
    ])

    // True all-time stats for LIVE trades only (paper/backtest excluded).
    const liveOnly = lifetimeTradesRaw.filter((t) => t.live)
    const lifetimeStats = {
      totalTrades: lifetimeTradesRaw.length,
      totalPnl: lifetimeTradesRaw.reduce((s, t) => s + (t.pnl || 0), 0),
      winRate: lifetimeTradesRaw.length > 0 ? lifetimeTradesRaw.filter((t) => (t.pnl || 0) > 0).length / lifetimeTradesRaw.length : 0,
    }

    const cfg = cfgRows[0]
    if (!cfg) return NextResponse.json({ error: "Config not found" }, { status: 500 })

    const liveAccount = cfg.mode === "live" ? await fetchLiveAccount() : null

    let ticker = null
    let chart: { time: number; close: number; emaFast: number; emaSlow: number }[] = []
    let regime: Regime | null = null
    let adxValue: number | null = null
    try {
      const [t, candles] = await Promise.all([fetchTicker(cfg.symbol), fetchKlines(cfg.symbol, cfg.timeframe, 200)])
      ticker = t
      const closes = candles.map((c) => c.close)
      const emaF = ema(closes, cfg.emaFast), emaS = ema(closes, cfg.emaSlow)
      chart = candles.slice(-100).map((c, i) => {
        const j = candles.length - 100 + i
        return { time: c.time, close: c.close, emaFast: emaF[j], emaSlow: emaS[j] }
      })
      if (candles.length >= 60) {
        const snap = computeSnapshot(candles, cfg)
        regime = detectRegime(snap, cfg)
        adxValue = snap.adx
      }
    } catch {}

    const openPosition = openPosRows.find(p => p.symbol === cfg.symbol && p.timeframe === cfg.timeframe) ?? null
    const markPrice = ticker?.lastPrice ?? null

    const exposureSymbols = [...new Set([...openPosRows.map(p => p.symbol), ...activeGridOrders.map(o => o.symbol)])]
    const exposureTickers = await Promise.all(exposureSymbols.map(async (s) => {
      try { return [s, (await fetchTicker(s)).lastPrice] as const }
      catch { return [s, null] as const }
    }))
    const markBySymbol = new Map(exposureTickers)

    const exposures = openPosRows.map(p => {
      const mark = markBySymbol.get(p.symbol) ?? null
      const dir = p.side === "long" ? 1 : -1
      return { position: p, markPrice: mark, unrealizedPnl: mark == null ? 0 : (mark - p.entryPrice) * dir * p.quantity, selected: p.symbol === cfg.symbol && p.timeframe === cfg.timeframe }
    })
    const unrealizedPnl = exposures.reduce((t, e) => t + e.unrealizedPnl, 0)

    const wins = recentTrades.filter(t => t.pnl > 0).length
    const winRate = recentTrades.length > 0 ? wins / recentTrades.length : 0

    // Legacy single-grid for selected market (keeps existing GridCard working)
    const selectedGridOrders = activeGridOrders.filter(o => o.symbol === cfg.symbol && o.timeframe === cfg.timeframe)
    const selectedDir = gridConfigRows.find(gc => gc.symbol === cfg.symbol && gc.timeframe === cfg.timeframe)?.direction || "long"
    let gridUnrealized = 0
    for (const o of selectedGridOrders) {
      const mark = markBySymbol.get(o.symbol)
      if (!mark || !o.buyPrice) continue
      if (selectedDir === "long" && o.side === "sell") {
        gridUnrealized += (mark - o.buyPrice) * o.quantity
      } else if (selectedDir === "short" && o.side === "buy") {
        gridUnrealized += (o.buyPrice - mark) * o.quantity
      }
    }
    const gridHolding = selectedGridOrders.filter(o => (selectedDir === "long" && o.side === "sell" && o.buyPrice) || (selectedDir === "short" && o.side === "buy" && o.buyPrice))
    let totalGridUnrealized = 0
    for (const gc of gridConfigRows) {
      const mark = markBySymbol.get(gc.symbol)
      if (!mark) continue
      const orders = activeGridOrders.filter(o => o.symbol === gc.symbol && o.timeframe === gc.timeframe)
      const dir = gc.direction || "long"
      for (const o of orders) {
        // Open longs are pending SELL orders with a recorded buyPrice (entry)
        if (dir === "long" && o.side === "sell" && o.buyPrice) {
          totalGridUnrealized += (mark - o.buyPrice) * o.quantity
        }
        // Open shorts are pending BUY orders with a recorded buyPrice (entry)
        else if (dir === "short" && o.side === "buy" && o.buyPrice) {
          totalGridUnrealized += (o.buyPrice - mark) * o.quantity
        }
      }
    }
    const gridRealized = recentTrades.filter(t => t.strategy === "grid" && t.symbol === cfg.symbol).reduce((t, trade) => t + trade.pnl, 0)

    // Multi-pair grid configs with live state
    const gridConfigsState = await Promise.all(gridConfigRows.map(async (gc) => {
      const orders = activeGridOrders.filter(o => o.symbol === gc.symbol && o.timeframe === gc.timeframe)
      const buys = orders.filter(o => o.side === "buy")
      const mark = markBySymbol.get(gc.symbol) ?? null
      let unrealized = 0
      const dir = gc.direction || "long"
      for (const o of orders) {
        if (!mark || !o.buyPrice) continue
        if (dir === "long" && o.side === "sell") {
          unrealized += (mark - o.buyPrice) * o.quantity
        } else if (dir === "short" && o.side === "buy") {
          unrealized += (o.buyPrice - mark) * o.quantity
        }
      }
      const realized = recentTrades.filter(t => t.strategy === "grid" && t.symbol === gc.symbol && (cfg.mode === "live" ? (t.live === true) : (t.live !== true))).reduce((t, trade) => t + trade.pnl, 0)
      return {
        symbol: gc.symbol,
        timeframe: gc.timeframe,
        enabled: gc.enabled,
        paused: gc.paused,
        levels: gc.levels,
        effectiveLevels: gc.effectiveLevels ?? gc.levels,
        atrMult: gc.rangeAtrMult,
        gridLeverage: gc.leverage,
        spacing: gc.spacing,
        buyCount: buys.length,
        sellCount: (typeof sells !== "undefined" ? sells.length : (typeof active !== "undefined" ? active : typeof orders !== "undefined" ? orders : []).filter((o: any) => o.side === "sell").length),
        unrealizedPnl: unrealized,
        realizedPnl: realized,
        budgetPct: gc.budgetPct,
        leverage: gc.leverage,
        makerMode: gc.makerMode,
        direction: gc.direction || "long",
        autoDirection: gc.direction === "auto" ? (gc as any)._autoSide || "neutral" : null,
      }
    }))

    const managedMarkets = [...new Set([...openPosRows.map(p => `${p.symbol}|${p.timeframe}`), ...activeGridOrders.map(o => `${o.symbol}|${o.timeframe}`)])].map(key => {
      const [s, tf] = key.split("|")
      return { symbol: s, timeframe: tf, positionCount: openPosRows.filter(p => p.symbol === s && p.timeframe === tf).length, gridOrderCount: activeGridOrders.filter(o => o.symbol === s && o.timeframe === tf).length, selected: s === cfg.symbol && tf === cfg.timeframe }
    })

    const marketDecisions = decisions.filter(d => d.symbol === cfg.symbol && d.timeframe === cfg.timeframe)
    const resolvedDecisions = marketDecisions.filter(d => d.resolvedAt)
    const logisticResolved = resolvedDecisions.filter(d => d.logisticAllowed)
    const lorentzianResolved = resolvedDecisions.filter(d => d.lorentzianDirection !== "neutral")
    const agreementCount = marketDecisions.filter(d => d.logisticAllowed && d.lorentzianAllowed && d.candidateDirection === d.lorentzianDirection).length
    const classifierAnalytics = {
      sampleCount: marketDecisions.length, resolvedCount: resolvedDecisions.length,
      acceptedCount: marketDecisions.filter(d => d.finalAllowed).length,
      rejectedCount: marketDecisions.filter(d => !d.finalAllowed).length,
      agreementRate: marketDecisions.length > 0 ? agreementCount / marketDecisions.length : null,
      logisticAccuracy: logisticResolved.length > 0 ? logisticResolved.filter(d => d.outcomeCorrectLogistic).length / logisticResolved.length : null,
      lorentzianAccuracy: lorentzianResolved.length > 0 ? lorentzianResolved.filter(d => d.outcomeCorrectLorentzian).length / lorentzianResolved.length : null,
      latest: marketDecisions[0] ?? null,
    }

    return NextResponse.json({
      rotationEnabled: isRotationEnabled(),
      lastRotationTime: getLastRotationTime(),
      shadowStats,
      config: cfg, openPosition, openPositions: openPosRows, exposures, managedMarkets,
      markPrice, unrealizedPnl: totalGridUnrealized,
      equity: cfg.paperBalance + totalGridUnrealized,
      trades: recentTrades, winRate, lifetimeStats, equityCurve: equity.reverse(), logs,
      model: modelRows[0] ?? null, classifierAnalytics, ticker, chart, liveAccount, regime, adxValue,
      grid: { orders: selectedGridOrders, allOrders: activeGridOrders, holdingCount: gridHolding.length, unrealizedPnl: gridUnrealized, realizedPnl: gridRealized },
      gridConfigs: gridConfigsState,
    })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown error" }, { status: 500 })
  }
}

// Grid config toggle endpoint
export async function POST(request: Request) {
  try {
    const body = await request.json()
    if (body.action === "toggle-grid" && body.symbol) {
      const gc = await db.select().from(gridConfigs).where(eq(gridConfigs.symbol, body.symbol)).limit(1)
      if (gc.length > 0) {
        await db.update(gridConfigs).set({ enabled: !gc[0].enabled }).where(eq(gridConfigs.id, gc[0].id))
        return NextResponse.json({ ok: true })
      }
    }
    return NextResponse.json({ error: "Invalid action" }, { status: 400 })
  } catch (err) {
    return NextResponse.json({ error: err instanceof Error ? err.message : "Unknown" }, { status: 500 })
  }
}
