"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { useSWRConfig } from "swr"
import { TrendingUp, TrendingDown, Percent } from "lucide-react"

interface SwingConfig {
  enabled: boolean
  riskPct: number
  symbols: string[]
  leverage: number
}

interface SwingPosition {
  id: number
  symbol: string
  side: string
  entryPrice: number
  sizeUsdt: number
  stopLoss: number
  takeProfit: number
  openedAt: string
}

interface SwingStats {
  totalTrades: number
  totalPnl: number
  winRate: number
  openPositions: number
}

const AVAILABLE_SYMBOLS = ["BTC_USDT", "ETH_USDT", "SOL_USDT", "AVAX_USDT", "LINK_USDT"]

export function SwingCard({ state }: { state: any }) {
  const { mutate } = useSWRConfig()
  const [config, setConfig] = useState<SwingConfig>({
    enabled: false,
    riskPct: 0.02,
    symbols: ["BTC_USDT", "ETH_USDT"],
    leverage: 1,
  })
  const [loading, setLoading] = useState(false)

  const positions: SwingPosition[] = state.swingPositions || []
  const stats: SwingStats = state.swingStats || { totalTrades: 0, totalPnl: 0, winRate: 0, openPositions: 0 }

  useEffect(() => {
    if (state.config) {
      setConfig({
        enabled: state.config.swingEnabled || false,
        riskPct: state.config.swingRiskPct || 0.02,
        symbols: state.config.swingSymbols || ["BTC_USDT", "ETH_USDT"],
        leverage: state.config.swingLeverage || 1,
      })
    }
  }, [state.config])

  const saveConfig = async () => {
    setLoading(true)
    try {
      const res = await fetch("/api/bot/swing-config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(config),
      })
      if (!res.ok) throw new Error("Failed to save config")
      await mutate("/api/bot/state")
    } catch (err) {
      console.error("Failed to save swing config:", err)
    } finally {
      setLoading(false)
    }
  }

  const toggleSymbol = (symbol: string) => {
    setConfig(prev => ({
      ...prev,
      symbols: prev.symbols.includes(symbol)
        ? prev.symbols.filter(s => s !== symbol)
        : [...prev.symbols, symbol],
    }))
  }

  const riskOptions = [0.01, 0.02, 0.03, 0.04, 0.05]

  return (
    <Card className="border-2 border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            <TrendingUp className="h-5 w-5 text-primary" />
            Swing Breakout (4H)
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={config.enabled ? "default" : "secondary"}>
              {config.enabled ? "Active" : "Inactive"}
            </Badge>
            <Button
              size="sm"
              variant={config.enabled ? "destructive" : "default"}
              onClick={() => setConfig(prev => ({ ...prev, enabled: !prev.enabled }))}
            >
              {config.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          4-hour trend-following breakout strategy. Validated on BTC + ETH (Phase G).
        </p>
      </CardHeader>
      <CardContent className="space-y-4">
        {/* Stats Row */}
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">PnL</div>
            <div className={`text-sm font-bold ${stats.totalPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
              ${stats.totalPnl.toFixed(2)}
            </div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">Win Rate</div>
            <div className="text-sm font-bold">{(stats.winRate * 100).toFixed(0)}%</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">Trades</div>
            <div className="text-sm font-bold">{stats.totalTrades}</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">Open</div>
            <div className="text-sm font-bold">{stats.openPositions}</div>
          </div>
        </div>

        {/* Controls */}
        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium flex items-center gap-2 mb-2">
              <Percent className="h-3 w-3" />
              Risk per Trade
            </label>
            <div className="flex gap-2">
              {riskOptions.map(risk => (
                <Button
                  key={risk}
                  size="sm"
                  variant={config.riskPct === risk ? "default" : "outline"}
                  onClick={() => setConfig(prev => ({ ...prev, riskPct: risk }))}
                  className="text-xs"
                >
                  {(risk * 100).toFixed(1)}%
                </Button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium mb-2 block">Symbols</label>
            <div className="flex flex-wrap gap-2">
              {AVAILABLE_SYMBOLS.map(symbol => (
                <Button
                  key={symbol}
                  size="sm"
                  variant={config.symbols.includes(symbol) ? "default" : "outline"}
                  onClick={() => toggleSymbol(symbol)}
                  className="text-xs"
                >
                  {symbol}
                </Button>
              ))}
            </div>
          </div>

          <Button onClick={saveConfig} disabled={loading} className="w-full" size="sm">
            {loading ? "Saving..." : "Save Configuration"}
          </Button>
        </div>

        {/* Open Positions */}
        {positions.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Open Positions</h4>
            <div className="space-y-2">
              {positions.map(pos => (
                <div key={pos.id} className="p-2 bg-muted/30 rounded text-xs space-y-1">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      {pos.side === "long" ? (
                        <TrendingUp className="h-3 w-3 text-green-500" />
                      ) : (
                        <TrendingDown className="h-3 w-3 text-red-500" />
                      )}
                      <span className="font-medium">{pos.symbol}</span>
                      <Badge variant="outline" className="text-[10px]">{pos.side.toUpperCase()}</Badge>
                    </div>
                    <span className="text-muted-foreground">${pos.sizeUsdt.toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div>
                      <div className="text-muted-foreground">Entry</div>
                      <div>${pos.entryPrice.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Stop</div>
                      <div className="text-red-500">${pos.stopLoss.toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Target</div>
                      <div className="text-green-500">${pos.takeProfit.toFixed(2)}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Strategy Details */}
        <div className="text-[10px] text-muted-foreground border-t pt-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="font-semibold mb-1">Entry</div>
              <div>20-bar breakout + trend filter</div>
            </div>
            <div>
              <div className="font-semibold mb-1">Exit</div>
              <div>3×ATR stop, 6×ATR target</div>
            </div>
            <div>
              <div className="font-semibold mb-1">Timeframe</div>
              <div>4 hours</div>
            </div>
            <div>
              <div className="font-semibold mb-1">Leverage</div>
              <div>{config.leverage}x</div>
            </div>
          </div>
        </div>
      </CardContent>
    </Card>
  )
}
