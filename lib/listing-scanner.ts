import { db } from "./db"
import { gridConfigs } from "./db/schema"
import { eq } from "drizzle-orm"
import { log } from "./logger"
import { computeSafeGridSettings } from "./grid-sizing"

// Cache of known symbols to detect new listings
let knownSymbols: Set<string> = new Set()
let lastScan = 0
const SCAN_INTERVAL = 5 * 60 * 1000 // 5 minutes

// Safety filters for new listings
const MIN_VOLUME_24H = 1_000_000 // $1M minimum volume
const MIN_PRICE = 0.001
const MAX_PRICE = 100
const BUDGET_PCT = 0.05 // 5% of total budget for new listings
const TTL_HOURS = 24 // Auto-delete after 24h

export async function scanNewListings(exchange: any): Promise<void> {
  const now = Date.now()
  if (now - lastScan < SCAN_INTERVAL) return
  lastScan = now

  try {
    // Fetch all USDT perpetual pairs from MEXC
    const markets = await exchange.loadMarkets()
    // Exclude tokenized stocks and leveraged tokens — these often don't
    // support opening a short (MEXC rejects with 2009 Position is
    // nonexistent), which breaks COMBO grids that need a naked short leg.
    const usdtPairs = Object.keys(markets).filter(s =>
      s.endsWith('_USDT') && markets[s].active &&
      !s.includes('STOCK') && !s.includes('3L') && !s.includes('3S')
    )
    
    // Initialize known symbols on first run
    if (knownSymbols.size === 0) {
      knownSymbols = new Set(usdtPairs)
      await log("info", `[Listing Scanner] Initialized with ${knownSymbols.size} known pairs`)
      return
    }

    // Detect new listings
    const newListings = usdtPairs.filter(s => !knownSymbols.has(s))
    
    for (const symbol of newListings) {
      try {
        const ticker = await exchange.fetchTicker(symbol)
        const price = ticker.last ?? 0
        const volume24h = (ticker.baseVolume ?? 0) * price

        // Apply safety filters
        if (volume24h < MIN_VOLUME_24H) {
          await log("info", `[Listing Scanner] ${symbol} skipped: low volume ($${volume24h.toFixed(0)})`)
          continue
        }
        if (price < MIN_PRICE || price > MAX_PRICE) {
          await log("info", `[Listing Scanner] ${symbol} skipped: price out of range ($${price})`)
          continue
        }

        // Auto-create COMBO grid for new listing
        await log("trade", `🚀 NEW LISTING DETECTED: ${symbol} | Price: $${price.toFixed(6)} | Vol: $${volume24h.toFixed(0)}`)
        
        const existingConfig = await db.select().from(gridConfigs).where(eq(gridConfigs.symbol, symbol))
        if (existingConfig.length > 0) {
          await log("info", `[Listing Scanner] ${symbol} already has a grid config, skipping`)
          knownSymbols.add(symbol)
          continue
        }

        // Insert new grid config sized against real available balance and
        // the number of pairs already competing for margin — a fixed
        // budgetPct/levels here previously ignored account size entirely
        // and could size a new listing into an unfundable ladder.
        const safe = await computeSafeGridSettings(1)
        await db.insert(gridConfigs).values({
          symbol,
          timeframe: "Min5", // Hyper-fast for new listing volatility
          direction: "neutral", // COMBO mode
          levels: safe.levels,
          rangeAtrMult: 1.5,
          leverage: safe.leverage,
          budgetPct: safe.budgetPct,
          autoPause: false, // Don't pause on trend - new listings are always trending
          enabled: true,
          makerMode: true,
          paused: false,
          metadata: { 
            isNewListing: true, 
            detectedAt: now,
            ttlHours: TTL_HOURS 
          }
        })

        await log("trade", `✅ Auto-created COMBO grid for ${symbol} (Min5, 10 levels, 5% budget, 24h TTL)`)
        knownSymbols.add(symbol)
      } catch (err) {
        // Individual ticker fetch failed, skip this symbol
        continue
      }
    }
  } catch (err) {
    await log("error", `[Listing Scanner] Error: ${err instanceof Error ? err.message : String(err)}`)
  }
}

// TTL cleanup: remove grids older than 24h that were auto-created
export async function cleanupExpiredListings(): Promise<void> {
  try {
    const allConfigs = await db.select().from(gridConfigs)
    const now = Date.now()
    const expired = allConfigs.filter(c => {
      const meta = c.metadata as any
      if (!meta?.isNewListing || !meta?.detectedAt) return false
      const age = now - meta.detectedAt
      return age > (meta.ttlHours ?? 24) * 60 * 60 * 1000
    })

    for (const config of expired) {
      await db.delete(gridConfigs).where(eq(gridConfigs.id, config.id))
      await log("trade", `🗑️ Removed expired listing grid: ${config.symbol} (24h TTL reached)`)
    }
  } catch (err) {
    // Silent fail on cleanup
  }
}
