import WebSocket from "ws"
import { log } from "../grid"

export const livePrices: Record<string, number> = {}
export const livePriceTimestamps: Record<string, number> = {}

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
  }

  public connect() {
    log("info", `[WS] Connecting to MEXC Contract WebSocket for ${this.symbol.toUpperCase()}...`)
    this.ws = new WebSocket(this.url)

    this.ws.on("open", () => {
      this.reconnectDelay = 3000
      log("info", `[WS] Connected. Subscribing to ${this.symbol.toUpperCase()} ${this.interval} klines...`)
      const subMsg = {
        method: "sub.kline",
        param: { symbol: this.symbol.toUpperCase(), interval: this.interval }
      }
      this.ws?.send(JSON.stringify(subMsg))

      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      this.heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          // Shotgun keep-alive: send BOTH documented MEXC ping formats
          this.ws.send("ping")
          this.ws.send(JSON.stringify({ method: "ping" }))
        }
      }, 15000)
    })

    this.ws.on("message", (data: WebSocket.RawData) => {
      const msg = data.toString()

      // Text keep-alive
      if (msg === "ping") { this.ws?.send("pong"); return }
      if (msg === "pong") return

      try {
        const parsed = JSON.parse(msg)

        // JSON keep-alive (documented MEXC spot/contract format)
        if (parsed.method === "ping" || parsed.channel === "ping") {
          this.ws?.send(JSON.stringify({ method: "pong" }))
          this.ws?.send("pong")
          return
        }
        if (parsed.method === "pong" || parsed.channel === "pong") return

        if (parsed.channel && parsed.channel.startsWith("push.kline") && parsed.data) {
          const k = parsed.data
          const sym = (k.symbol || this.symbol).toUpperCase()
          livePrices[sym] = parseFloat(k.close)
// INSTANT FILL TRIGGER: Wake up the engine immediately on live price move
if (typeof (globalThis as any).__triggerInstantTick === 'function') { (globalThis as any).__triggerInstantTick() }
          livePriceTimestamps[sym] = Date.now()
          const currentStartTime = k.t
          if (this.lastKlineTime !== null && currentStartTime > this.lastKlineTime) {
            const kline: KlineUpdate = {
              symbol: k.symbol || this.symbol.toUpperCase(),
              open: parseFloat(k.open), close: parseFloat(k.close),
              high: parseFloat(k.high), low: parseFloat(k.low),
              volume: parseFloat(k.vol), startTime: this.lastKlineTime, isClosed: true
            }
            this.onKline(kline)
          }
          this.lastKlineTime = currentStartTime
        }
      } catch (err) {}
    })

    this.ws.on("error", (err: Error) => {
      console.error(`[WS] Error: ${err.message}`)
      log("error", `[WS] Error: ${err.message}`)
    })

    this.ws.on("close", (code: number, reason: Buffer) => {
      console.log(`[WS] CLOSED: code=${code} reason=${reason?.toString() || "none"}`)
      // Only surface non-routine closes in the UI Activity Log
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
