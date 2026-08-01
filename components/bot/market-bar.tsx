"use client"

import { useEffect, useMemo, useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { ArrowRightLeft, Check, LoaderCircle, Radio } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Input } from "@/components/ui/input"
import { Badge } from "@/components/ui/badge"
import type { BotState } from "@/lib/use-bot-state"

interface Market {
  symbol: string
  displayName: string
  maxLeverage: number
}

interface MarketOptions {
  markets: Market[]
  timeframes: string[]
}

const fetcher = async (url: string) => {
  const response = await fetch(url)
  if (!response.ok) throw new Error("Could not load exchange markets")
  return response.json() as Promise<MarketOptions>
}

const timeframeLabel: Record<string, string> = {
  Min1: "1m",
  Min5: "5m",
  Min15: "15m",
  Min30: "30m",
  Min60: "1h",
  Hour4: "4h",
  Hour8: "8h",
  Day1: "1D",
}

export function MarketBar({ state }: { state: BotState }) {
  const { mutate } = useSWRConfig()
  const { data } = useSWR<MarketOptions>("/api/bot/market", fetcher, { revalidateOnFocus: false })
  const [symbol, setSymbol] = useState(state.config.symbol)
  const [timeframe, setTimeframe] = useState(state.config.timeframe)
  const [leverage, setLeverage] = useState(String(state.config.leverage))
  const [saving, setSaving] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    setSymbol(state.config.symbol)
    setTimeframe(state.config.timeframe)
    setLeverage(String(state.config.leverage))
  }, [state.config.symbol, state.config.timeframe, state.config.leverage])

  const selectedMarket = useMemo(
    () => data?.markets.find((market) => market.symbol === symbol.toUpperCase()),
    [data?.markets, symbol],
  )
  const dirty =
    symbol.toUpperCase() !== state.config.symbol ||
    timeframe !== state.config.timeframe ||
    Number(leverage) !== state.config.leverage

  const applyMarket = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      const response = await fetch("/api/bot/market", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ symbol: symbol.toUpperCase(), timeframe, leverage: Number(leverage) }),
      })
      const json = await response.json()
      if (!response.ok) throw new Error(json.error ?? "Market switch failed")
      await mutate("/api/bot/state")
      setFeedback("Market active")
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Market switch failed")
    } finally {
      setSaving(false)
    }
  }

  return (
    <section aria-label="Active trading market" className="rounded-xl border border-border bg-card shadow-sm">
      <div className="flex flex-col gap-4 p-4 xl:flex-row xl:items-center xl:justify-between">
        <div className="flex min-w-0 items-center gap-3">
          <div className="flex size-10 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
            <ArrowRightLeft aria-hidden="true" />
          </div>
          <div className="min-w-0">
            <div className="flex flex-wrap items-center gap-2">
              <h2 className="truncate font-mono text-lg font-semibold">{state.config.symbol.replace("_", "/")}</h2>
              <Badge variant="secondary">{timeframeLabel[state.config.timeframe] ?? state.config.timeframe}</Badge>
              <Badge variant="outline">{state.config.leverage}x</Badge>
              <Badge variant="outline" className="gap-1">
                <Radio aria-hidden="true" /> {state.config.mode.toUpperCase()}
              </Badge>
            </div>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xl font-semibold">
                {state.markPrice?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? "—"}
              </span>
              <span className="text-xs text-muted-foreground">
                {state.regime ? `${state.regime.toUpperCase()} · ADX ${state.adxValue?.toFixed(1) ?? "—"}` : "Market data loading"}
              </span>
            </div>
          </div>
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
          <label className="flex min-w-44 flex-1 flex-col gap-1 text-xs text-muted-foreground">
            Contract
            <Input
              value={symbol}
              list="mexc-contracts"
              onChange={(event) => setSymbol(event.target.value.toUpperCase())}
              placeholder="BTC_USDT"
              className="h-9 font-mono text-foreground"
              autoComplete="off"
            />
            <datalist id="mexc-contracts">
              {data?.markets.map((market) => <option key={market.symbol} value={market.symbol}>{market.displayName}</option>)}
            </datalist>
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Timeframe
            <select
              value={timeframe}
              onChange={(event) => setTimeframe(event.target.value)}
              className="h-9 min-w-24 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {(data?.timeframes ?? Object.keys(timeframeLabel)).map((value) => (
                <option key={value} value={value}>{timeframeLabel[value] ?? value}</option>
              ))}
            </select>
          </label>

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Leverage
            <select
              value={leverage}
              onChange={(event) => setLeverage(event.target.value)}
              className="h-9 min-w-24 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            >
              {[1, 2, 3, 5, 10, 15, 20, 25, 50, 75, 100]
                .filter((value) => value <= (selectedMarket?.maxLeverage ?? 100))
                .map((value) => <option key={value} value={String(value)}>{value}x</option>)}
            </select>
          </label>

          <Button className="h-9" disabled={!dirty || saving} onClick={applyMarket}>
            {saving ? <LoaderCircle data-icon="inline-start" className="animate-spin" /> : <Check data-icon="inline-start" />}
            Apply market
          </Button>
        </div>
      </div>
      {(feedback || state.managedMarkets.some((market) => !market.selected)) && (
        <div className="flex flex-wrap items-center justify-between gap-2 border-t border-border px-4 py-2 text-xs text-muted-foreground">
          <span>{feedback ?? "Previous-market exposure remains under active management."}</span>
          <span>{state.managedMarkets.filter((market) => !market.selected).length} legacy market(s) managed</span>
        </div>
      )}
    </section>
  )
}
