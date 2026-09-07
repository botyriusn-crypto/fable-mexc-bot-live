"use client"

import { useState, useEffect } from "react"
import { Card, CardContent, CardHeader, CardTitle } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { Input } from "@/components/ui/input"
import { useSWRConfig } from "swr"
import { TrendingUp, TrendingDown } from "lucide-react"

interface FundingConfig {
  enabled: boolean
  thresholdBps: number
  lookbackH: number
  horizonH: number
  sizeUsdt: number
  leverage: number
  tpBps: number
  slBps: number
}

const DEFAULTS: FundingConfig = {
  enabled: false,
  thresholdBps: 5,
  lookbackH: 72,
  horizonH: 24,
  sizeUsdt: 50,
  leverage: 3,
  tpBps: 50,
  slBps: 30,
}

export function FundingCard({ state }: { state: any }) {
  const { mutate } = useSWRConfig()
  const [config, setConfig] = useState<FundingConfig>(DEFAULTS)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)

  const positions: any[] = (state.openPositions || []).filter((p: any) => p.strategy === "funding_carry")
  const ftrades: any[] = (state.trades || []).filter((t: any) => t.strategy === "funding_carry")
  const totalPnl = ftrades.reduce((s: number, t: any) => s + (Number(t.pnl) || 0), 0)
  const winRate = ftrades.length > 0 ? ftrades.filter((t: any) => Number(t.pnl) > 0).length / ftrades.length : 0

  useEffect(() => {
    const c = state.config
    if (c) {
      setConfig({
        enabled: c.fundingCarryEnabled || false,
        thresholdBps: (Number(c.fundingCarryThreshold) || 0.0005) * 10000,
        lookbackH: Math.round((Number(c.fundingCarryMomentumLookbackSec) || 259200) / 3600),
        horizonH: Math.round((Number(c.fundingCarryHorizonSec) || 86400) / 3600),
        sizeUsdt: Number(c.fundingCarrySizeUsdt) || 50,
        leverage: Number(c.fundingCarryLeverage) || 3,
        tpBps: Number(c.fundingCarryTpBps) || 50,
        slBps: Number(c.fundingCarrySlBps) || 30,
      })
    }
  }, [state.config])

  const saveConfig = async (next?: Partial<FundingConfig>) => {
    const merged = { ...config, ...next }
    if (next) setConfig(merged)
    setLoading(true)
    setError(null)
    try {
      const res = await fetch("/api/bot/config", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          fundingCarryEnabled: merged.enabled,
          fundingCarryThreshold: merged.thresholdBps / 10000,
          fundingCarryMomentumLookbackSec: Math.round(merged.lookbackH * 3600),
          fundingCarryHorizonSec: Math.round(merged.horizonH * 3600),
          fundingCarrySizeUsdt: merged.sizeUsdt,
          fundingCarryLeverage: merged.leverage,
          fundingCarryTpBps: merged.tpBps,
          fundingCarrySlBps: merged.slBps,
        }),
      })
      const json = await res.json().catch(() => ({}))
      if (!res.ok) throw new Error((json as any).error ?? "Failed to save funding config")
      await mutate("/api/bot/state")
    } catch (err) {
      setError(err instanceof Error ? err.message : "Failed to save funding config")
    } finally {
      setLoading(false)
    }
  }

  const bybitOnly = (state.config?.exchange || "mexc") !== "bybit"

  return (
    <Card className="border-2 border-primary/20">
      <CardHeader className="pb-3">
        <div className="flex items-center justify-between">
          <CardTitle className="flex items-center gap-2">
            {config.enabled ? <TrendingUp className="h-5 w-5 text-primary" /> : <TrendingDown className="h-5 w-5 text-muted-foreground" />}
            Funding Momentum
          </CardTitle>
          <div className="flex items-center gap-2">
            <Badge variant={config.enabled ? "default" : "secondary"}>
              {config.enabled ? "Active" : "Inactive"}
            </Badge>
            <Button
              size="sm"
              variant={config.enabled ? "destructive" : "default"}
              onClick={() => saveConfig({ enabled: !config.enabled })}
              disabled={loading}
            >
              {config.enabled ? "Disable" : "Enable"}
            </Button>
          </div>
        </div>
        <p className="text-xs text-muted-foreground">
          Bybit funding extremes + crowding momentum. Scans all USDT perps, one position per tick, max 3 open. Bybit only.
        </p>
        {bybitOnly && (
          <p className="text-xs text-danger">Switch exchange to Bybit for this strategy to trade.</p>
        )}
      </CardHeader>
      <CardContent className="space-y-4">
        <div className="grid grid-cols-4 gap-2">
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">PnL</div>
            <div className={`text-sm font-bold ${totalPnl >= 0 ? "text-green-500" : "text-red-500"}`}>
              ${totalPnl.toFixed(2)}
            </div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">Win Rate</div>
            <div className="text-sm font-bold">{(winRate * 100).toFixed(0)}%</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">Trades</div>
            <div className="text-sm font-bold">{ftrades.length}</div>
          </div>
          <div className="text-center p-2 bg-muted/50 rounded">
            <div className="text-xs text-muted-foreground">Open</div>
            <div className="text-sm font-bold">{positions.length}</div>
          </div>
        </div>

        <div className="space-y-3">
          <div>
            <label className="text-xs font-medium mb-2 block">Extreme threshold (bps)</label>
            <div className="flex gap-2">
              {[1, 5, 10, 25].map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={config.thresholdBps === v ? "default" : "outline"}
                  onClick={() => setConfig((prev) => ({ ...prev, thresholdBps: v }))}
                  className="text-xs"
                >
                  {v}
                </Button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium mb-2 block">Trailing mean lookback (hours)</label>
            <div className="flex gap-2">
              {[24, 72, 168].map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={config.lookbackH === v ? "default" : "outline"}
                  onClick={() => setConfig((prev) => ({ ...prev, lookbackH: v }))}
                  className="text-xs"
                >
                  {v}h
                </Button>
              ))}
            </div>
          </div>

          <div>
            <label className="text-xs font-medium mb-2 block">Max hold (hours)</label>
            <div className="flex gap-2">
              {[8, 24, 48].map((v) => (
                <Button
                  key={v}
                  size="sm"
                  variant={config.horizonH === v ? "default" : "outline"}
                  onClick={() => setConfig((prev) => ({ ...prev, horizonH: v }))}
                  className="text-xs"
                >
                  {v}h
                </Button>
              ))}
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium mb-2 block">Size (USDT)</label>
              <Input
                type="number"
                min={5}
                value={config.sizeUsdt}
                onChange={(e) => setConfig((prev) => ({ ...prev, sizeUsdt: Number(e.target.value) || 0 }))}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-2 block">Leverage</label>
              <div className="flex gap-1">
                {[1, 2, 3, 5].map((v) => (
                  <Button
                    key={v}
                    size="sm"
                    variant={config.leverage === v ? "default" : "outline"}
                    onClick={() => setConfig((prev) => ({ ...prev, leverage: v }))}
                    className="text-xs px-2"
                  >
                    {v}x
                  </Button>
                ))}
              </div>
            </div>
          </div>

          <div className="grid grid-cols-2 gap-2">
            <div>
              <label className="text-xs font-medium mb-2 block">Take profit (bps)</label>
              <Input
                type="number"
                min={1}
                value={config.tpBps}
                onChange={(e) => setConfig((prev) => ({ ...prev, tpBps: Number(e.target.value) || 0 }))}
                className="h-8 text-xs"
              />
            </div>
            <div>
              <label className="text-xs font-medium mb-2 block">Stop loss (bps)</label>
              <Input
                type="number"
                min={1}
                value={config.slBps}
                onChange={(e) => setConfig((prev) => ({ ...prev, slBps: Number(e.target.value) || 0 }))}
                className="h-8 text-xs"
              />
            </div>
          </div>

          {error && <div className="text-xs text-danger">{error}</div>}
          <Button onClick={() => saveConfig()} disabled={loading} className="w-full" size="sm">
            {loading ? "Saving..." : "Save Configuration"}
          </Button>
        </div>

        {positions.length > 0 && (
          <div>
            <h4 className="text-sm font-semibold mb-2">Open Positions</h4>
            <div className="space-y-2">
              {positions.map((pos: any) => (
                <div key={pos.id} className="p-2 bg-muted/30 rounded text-xs space-y-1">
                  <div className="flex justify-between items-center">
                    <div className="flex items-center gap-2">
                      <span className="font-medium">{String(pos.symbol || "UNKNOWN").replace("_", "/")}</span>
                      <Badge variant="outline" className="text-[10px]">{String(pos.side || "?").toUpperCase()}</Badge>
                    </div>
                    <span className="text-muted-foreground">${Number(pos.sizeUsdt || 0).toFixed(0)}</span>
                  </div>
                  <div className="grid grid-cols-3 gap-2 text-[10px]">
                    <div>
                      <div className="text-muted-foreground">Entry</div>
                      <div>${Number(pos.entryPrice || 0).toFixed(2)}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Stop</div>
                      <div className="text-red-500">{pos.stopLoss != null ? `$${Number(pos.stopLoss).toFixed(2)}` : "—"}</div>
                    </div>
                    <div>
                      <div className="text-muted-foreground">Target</div>
                      <div className="text-green-500">{pos.takeProfit != null ? `$${Number(pos.takeProfit).toFixed(2)}` : "—"}</div>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="text-[10px] text-muted-foreground border-t pt-2">
          <div className="grid grid-cols-2 gap-2">
            <div>
              <div className="font-semibold mb-1">Entry</div>
              <div>Extreme funding + rollover fade</div>
            </div>
            <div>
              <div className="font-semibold mb-1">Exit</div>
              <div>{config.tpBps}bps TP, {config.slBps}bps SL, {config.horizonH}h max</div>
            </div>
            <div>
              <div className="font-semibold mb-1">Universe</div>
              <div>All Bybit USDT perps</div>
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
