export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initRealtimeEngine } = await import("./lib/engine")
    const { db } = await import("./lib/db")
    const { gridConfigs } = await import("./lib/db/schema")
    const { eq } = await import("drizzle-orm")
    
    try {
      const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
      for (const c of configs) {
        initRealtimeEngine(c.symbol, c.timeframe)
      }
      console.log(`[Startup] Real-time WebSocket engines initialized for ${configs.length} grid pairs.`)
      
      // Reconcile DB with actual MEXC exchange state
      const { syncExchangeState } = await import("./lib/grid")
      await syncExchangeState()
    } catch (err) {
      console.error("[Startup] Failed to initialize WebSockets:", err)
      // Fallback to BTC/SOL if DB isn't ready yet
      initRealtimeEngine("BTC_USDT", "Min5")
      initRealtimeEngine("SOL_USDT", "Min5")
    }
  }
}
