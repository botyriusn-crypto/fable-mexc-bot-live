import WebSocket from "ws"
// NOTE: this file used to import `log` from "../grid", creating a cycle
// (grid -> mexc/ws -> grid). It resolved by luck because `log` is only called
// from inside event handlers, but any future top-level use would have been
// `undefined` at init. lib/logger has no imports back into grid, so the cycle
// is gone.
import { log } from "../logger"

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

const RECONNECT_DELAY_MS = 3000
const HEARTBEAT_MS = 15000

export class MexcWebSocketManager {
  private ws: WebSocket | null = null
  private url: string
  private symbol: string
  private interval: string
  private onKline: (kline: KlineUpdate) => void
  private isReconnecting = false
  private heartbeatInterval: NodeJS.Timeout | null = null
  private lastKlineTime: number | null = null

  constructor(symbol: string, interval: string, onKline: (kline: KlineUpdate) => void) {
    this.url = "wss://contract.mexc.com/edge"
    this.symbol = symbol.toLowerCase()
    this.interval = interval.charAt(0).toUpperCase() + interval.slice(1)
    this.onKline = onKline
  }

  public connect() {
    this.ws = new WebSocket(this.url)

    this.ws.on("open", () => {
      // Reset the candle clock on (re)connect. Leaving the previous run's
      // lastKlineTime in place meant the first frame after a reconnect looked
      // like a brand-new candle and fired a spurious onKline() tick.
      this.lastKlineTime = null

      const subMsg = {
        method: "sub.kline",
        param: { symbol: this.symbol.toUpperCase(), interval: this.interval }
      }
      this.ws?.send(JSON.stringify(subMsg))
      log("info", `[WS] Connected: ${this.symbol.toUpperCase()} ${this.interval} klines`).catch(() => {})

      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: "ping" }))
        }
      }, HEARTBEAT_MS)
    })

    this.ws.on("message", (data: WebSocket.RawData) => {
      const msg = data.toString()

      // Text keep-alive
      if (msg === "ping") { this.ws?.send("pong"); return }
      if (msg === "pong") return

      try {
        const parsed = JSON.parse(msg)

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

          // NEW CANDLE DETECTION: if timestamp changed, the previous candle is closed
          if (this.lastKlineTime !== null && currentTime > this.lastKlineTime) {
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
      log("error", `[WS] Error: ${err.message}`).catch(() => {})
    })

    this.ws.on("close", (code: number, reason: Buffer) => {
      if (code !== 1005 && code !== 1006) {
        log("info", `[WS] CLOSED: code=${code} reason=${reason?.toString() || "none"}`).catch(() => {})
      }
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      if (!this.isReconnecting) {
        this.isReconnecting = true
        setTimeout(() => { this.isReconnecting = false; this.connect() }, RECONNECT_DELAY_MS)
      }
    })
  }

  public disconnect() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    this.ws?.close()
    this.ws = null
  }
}
