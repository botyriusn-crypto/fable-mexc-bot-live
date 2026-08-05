export async function register() {
  // Only run on the server, not during build
  if (process.env.NEXT_RUNTIME === "nodejs") {
    const { initRealtimeEngine } = await import("./lib/engine")
    
    // Initialize the WebSocket engine for BTC and SOL on startup
    initRealtimeEngine("BTC_USDT", "Min5")
    initRealtimeEngine("SOL_USDT", "Min5")
    
    console.log("[Startup] Real-time WebSocket engine initialized automatically.")
  }
}
