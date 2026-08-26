export async function register() {
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initRealtimeEngine } = await import("./lib/engine")
    const { db } = await import("./lib/db")
    const { gridConfigs, botConfig } = await import("./lib/db/schema")
    const { eq } = await import("drizzle-orm")

    const isRunning = async () => {
      const rows = await db.select().from(botConfig).where(eq(botConfig.id, 1))
      return rows[0]?.status === "running"
    }

    try {
      const { fetchMarkets } = await import("./lib/mexc/public")
      await fetchMarkets()

      const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
      if (await isRunning()) {
        for (const c of configs) {
          initRealtimeEngine(c.symbol, c.timeframe)
        }
        console.log(`[Startup] Real-time WebSocket engines initialized for ${configs.length} grid pairs.`)
      } else {
        console.log("[Startup] Bot is stopped — skipping WebSocket engine init.")
      }

      const { syncExchangeState } = await import("./lib/grid")
      if (await isRunning()) {
        await syncExchangeState()
      }

      setInterval(async () => {
        try {
          if (!(await isRunning())) return
          await syncExchangeState()
        } catch (e) {
          console.error("[Reconcile] Scheduled sync failed:", e)
        }
      }, 15 * 60 * 1000)

      const { evaluateAiPicks } = await import("./lib/ai-feedback")
      setInterval(async () => {
        try {
          if (!(await isRunning())) return
          await evaluateAiPicks()
        } catch (e) {
          console.error("[AI Feedback] Scheduled evaluation failed:", e)
        }
      }, 30 * 60 * 1000)

      const { checkAllHeldPositionsRisk } = await import("./lib/grid")
      setInterval(async () => {
        try {
          if (!(await isRunning())) return
          await checkAllHeldPositionsRisk()
        } catch (e) {
          console.error("[Risk Check] Scheduled check failed:", e)
        }
      }, 20 * 1000)

      const { runTick } = await import("./lib/engine")
      setInterval(async () => {
        try {
          await runTick()
        } catch (e) {
          console.error("[Tick] Scheduled runTick failed:", e)
        }
      }, 60 * 1000)

      const { autoRebalance } = await import("./lib/portfolio-sizing")
      setInterval(async () => {
        try {
          if (!(await isRunning())) return
          await autoRebalance()
        } catch (e) {
          console.error("[Rebalance] Scheduled auto-rebalance failed:", e)
        }
      }, 5 * 60 * 60 * 1000)
    } catch (err) {
      console.error("[Startup] Failed to initialize WebSockets:", err)
      if (await isRunning()) {
        initRealtimeEngine("BTC_USDT", "Min5")
        initRealtimeEngine("SOL_USDT", "Min5")
      }
    }
  }
}
