import WebSocket from "ws"
import { log } from "../grid" // Reusing your DB logger

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
    // MEXC Contract (Futures) WebSocket endpoint
    this.url = "wss://contract.mexc.com/edge"
    this.symbol = symbol.toLowerCase()
    // MEXC Contract intervals are like Min1, Min5, Min15 (capitalized)
    this.interval = interval.charAt(0).toUpperCase() + interval.slice(1)
    this.onKline = onKline
  }

  public connect() {
    log("info", `[WS] Connecting to MEXC Contract WebSocket for ${this.symbol.toUpperCase()}...`)
    this.ws = new WebSocket(this.url)

    this.ws.on("open", () => {
      this.reconnectDelay = 3000 // Reset backoff on success
      log("info", `[WS] Connected. Subscribing to ${this.symbol.toUpperCase()} ${this.interval} klines...`)
      
      // MEXC Contract Subscription message format
      const subMsg = {
        method: "sub.kline",
        param: {
          symbol: this.symbol.toUpperCase(),
          interval: this.interval
        }
      }
      this.ws?.send(JSON.stringify(subMsg))

      // Clear any existing heartbeat
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      
      // Proactively send ping every 10s to prevent MEXC 30s heartbeat timeout
      this.heartbeatInterval = setInterval(() => {
        if (this.ws?.readyState === WebSocket.OPEN) {
          this.ws.send(JSON.stringify({ method: "ping" }))
        }
      }, 10000)
    })

    this.ws.on("message", (data: WebSocket.RawData) => {
      const msg = data.toString()
      
      // MEXC contract sends a plain string "pong" back
      if (msg === "pong" || msg.includes("pong")) return

      try {
        const parsed = JSON.parse(msg)

        // Parse contract kline data (MEXC format: { data: { t, o, c, h, l, ... } })
        if (parsed.channel && parsed.channel.startsWith("push.kline") && parsed.data) {
          const k = parsed.data
          const currentStartTime = k.t
          
          // If we have a previous timestamp, and the new timestamp is greater, 
          // it means the previous candle just closed!
          if (this.lastKlineTime !== null && currentStartTime > this.lastKlineTime) {
            const kline: KlineUpdate = {
              symbol: k.symbol || this.symbol.toUpperCase(),
              open: parseFloat(k.o),
              close: parseFloat(k.c),
              high: parseFloat(k.h),
              low: parseFloat(k.l),
              volume: parseFloat(k.a), // 'a' is base volume in MEXC contract
              startTime: this.lastKlineTime,
              isClosed: true
            }
            this.onKline(kline)
          }
          
          // Update the last known timestamp
          this.lastKlineTime = currentStartTime
        }
      } catch (err) {
        // Silently ignore non-JSON or unexpected messages
      }
    })

    this.ws.on("error", (err: Error) => {
      log("error", `[WS] Error: ${err.message}`)
    })

    this.ws.on("close", () => {
      if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
      if (!this.isReconnecting) {
        this.isReconnecting = true
        log("info", `[WS] Disconnected. Reconnecting in ${this.reconnectDelay / 1000}s...`)
        setTimeout(() => {
          this.isReconnecting = false
          // Exponential backoff: double the delay up to max 30s
          this.reconnectDelay = Math.min(this.reconnectDelay * 2, 30000)
          this.connect()
        }, this.reconnectDelay)
      }
    })

    // Reset reconnect delay on successful connection
    const originalOnOpen = this.ws.on.bind(this.ws)
    // (We override the open handler reset logic below in the script)
  }

  public disconnect() {
    if (this.heartbeatInterval) clearInterval(this.heartbeatInterval)
    this.ws?.close()
    this.ws = null
    log("info", `[WS] Disconnected from ${this.symbol.toUpperCase()}.`)
  }
}
