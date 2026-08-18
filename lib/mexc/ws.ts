import WebSocket from "ws"
import { log } from "../grid"

export const livePrices: Record<string, number> = ((globalThis as any).__livePrices || ((globalThis as any).__livePrices = {}))
export const livePriceTimestamps: Record<string, number> = ((globalThis as any).__livePriceTimestamps || ((globalThis as any).__livePriceTimestamps = {}))

export interface KlineUpdate {
  symbol: string
  open: number
  close: number
  high: number
  low: number
  volume: number
  startTime: number
  isClosed: boolean
}

export class MexcWebSocketManager {
  private ws: WebSocket | null = null
  private url: string
  private symbol: string
  private interval: string
  private onKline: (kline: KlineUpdate) => void
  private isReconnecting = false
  private reconnectDelay = 3000
  private heartbeatInterval: NodeJS.Timeout | null = null
  private lastKlineTime: number | null = null

  constructor(symbol: string, interval: string, onKline: (kline: KlineUpdate) => void) {
    this.url = "wss://contract.mexc.com/edge"
    this.symbol = symbol.toLowerCase()
    this.interval = interval.charAt(0).toUpperCase() + interval.slice(1)
    this.onKline = onKline
    console.log(`[WS] Manager created for ${this.symbol}`);
  }

  public connect() {
    console.log(`[WS] connect() called for ${this.symbol}`);
    this.ws = new WebSocket(this.url)

    this.ws.on("open", () => {
      this.reconnectDelay = 3000
      console.log(`[WS] Connected. Subscribing to ${this.symbol.toUpperCase()} ${this.interval} klines...`)
      const subMsg = {
        method: "sub.kline",
        param: { symbol: this.symbol.toUpperCase(), interval: this.interval }
      }
      this.ws?.send(JSON.stringify(subMsg))
      console.log(`[WS] Subscription sent: ${JSON.stringify(subMsg)}`);

      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: "ping" }))
        }
      }, 15000)
    })

    this.ws.on("message", (data: WebSocket.RawData) => {
      const msg = data.toString()
      console.log(`[WS] Raw msg: ${msg.substring(0, 200)}`);

      // Text keep-alive
      if (msg === "ping") { this.ws?.send("pong"); return }
      if (msg === "pong") return

      try {
        const parsed = JSON.parse(msg)
        console.log(`[WS] Parsed: ${JSON.stringify(parsed).substring(0, 200)}`);

        // JSON keep-alive
        if (parsed.method === "ping" || parsed.channel === "ping") {
          this.ws?.send(JSON.stringify({ method: "pong" }))
          return
        }
        if (parsed.method === "pong" || parsed.channel === "pong") return

        // --- KLINE DETECTION ---
        // Check for kline data in parsed.data (MEXC contract format)
        if (parsed.data && typeof parsed.data === 'object' && parsed.data.t !== undefined && parsed.data.o !== undefined) {
          const k = parsed.data;
          const sym = (k.symbol || this.symbol).toUpperCase();
          const currentTime = k.t;
          
          console.log(`[WS] 📊 Kline for ${sym}: t=${currentTime}, o=${k.o}, c=${k.c}, h=${k.h}, l=${k.l}`);
          
          // NEW CANDLE DETECTION: if timestamp changed, the previous candle is closed
          if (this.lastKlineTime !== null && currentTime > this.lastKlineTime) {
            console.log(`[WS] 🔥 NEW CANDLE for ${sym}! Previous: ${this.lastKlineTime}, Current: ${currentTime}`);
            
            // Trigger callback for the closed candle
            const kline: KlineUpdate = {
              symbol: sym,
              open: parseFloat(k.o || 0),
              close: parseFloat(k.c || 0),
              high: parseFloat(k.h || 0),
              low: parseFloat(k.l || 0),
              volume: parseFloat(k.a || k.q || k.volume || 0),
              startTime: this.lastKlineTime,
              isClosed: true
            };
            console.log(`[WS] ✅ TRIGGERING callback for ${sym} at ${new Date().toISOString()}`);
            this.onKline(kline);
          }
          
          // Update last time
          if (k.t) this.lastKlineTime = k.t;
          
          // Update live price
          const closePrice = parseFloat(k.c || 0);
          if (!isNaN(closePrice)) livePrices[sym] = closePrice;
          livePriceTimestamps[sym] = Date.now();
          
          // REMOVED: Instant tick on every price update was causing rate limits
          // Only trigger on closed candles (handled above)
        }
      } catch (err) {
        console.error(`[WS] Error parsing message:`, err);
      }
    })

    this.ws.on("error", (err: Error) => {
      console.error(`[WS] Error event: ${err.message}`)
      log("error", `[WS] Error: ${err.message}`)
    })

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[WS] CLOSED: code=${code} reason=${reason?.toString() || "none"}`)
      if (code !== 1005 && code !== 1006) {
        log("info", `[WS] CLOSED: code=${code} reason=${reason?.toString() || "none"}`)
      }
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      if (!this.isReconnecting) {
        this.isReconnecting = true
        setTimeout(() => { this.isReconnecting = false; this.connect() }, 3000)
      }
    })
  }

  public disconnect() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    this.ws?.close()
    this.ws = null
  }
}
