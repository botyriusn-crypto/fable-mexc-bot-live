export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initRealtimeEngine } = await import("./lib/engine")
    const { db } = await import("./lib/db")
    const { gridConfigs } = await import("./lib/db/schema")
    const { eq } = await import("drizzle-orm")
    
    try {
      // Fetch markets to populate precision scales cache
      const { fetchMarkets } = await import("./lib/mexc/public")
      await fetchMarkets()
      
      const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
      for (const c of configs) {
        initRealtimeEngine(c.symbol, c.timeframe)
      }
      console.log(`[Startup] Real-time WebSocket engines initialized for ${configs.length} grid pairs.`)
      
      // Reconcile DB with actual MEXC exchange state on boot
      const { syncExchangeState } = await import("./lib/grid")
      await syncExchangeState()
      
      // Schedule recurring reconciliation every 15 minutes
      setInterval(async () => {
        try {
          await syncExchangeState()
        } catch (e) {
          console.error("[Reconcile] Scheduled sync failed:", e)
        }
      }, 15 * 60 * 1000)
      
      // Schedule AI Feedback evaluation every 30 minutes
      const { evaluateAiPicks } = await import("./lib/ai-feedback")
      setInterval(async () => {
        try {
          await evaluateAiPicks()
        } catch (e) {
          console.error("[AI Feedback] Scheduled evaluation failed:", e)
        }
      }, 30 * 60 * 1000)

      // Fast risk check (stop-loss / max-hold) for all held long and
      // short positions, decoupled from candle-close cadence. Uses
      // livePrices (already updating from the WS stream) instead of an
      // extra REST call. Long positions were previously only checked
      // once per candle close; shorts had no periodic check at all.
      const { checkAllHeldPositionsRisk } = await import("./lib/grid")
      setInterval(async () => {
        try {
          await checkAllHeldPositionsRisk()
        } catch (e) {
          console.error("[Risk Check] Scheduled check failed:", e)
        }
      }, 20 * 1000)
    } catch (err) {
      console.error("[Startup] Failed to initialize WebSockets:", err)
      // Fallback to BTC/SOL if DB isn't ready yet
      initRealtimeEngine("BTC_USDT", "Min5")
      initRealtimeEngine("SOL_USDT", "Min5")
    }
  }
}
