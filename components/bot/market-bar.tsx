"use client"

import { useEffect, useMemo, useRef, useState } from "react"
import useSWR, { useSWRConfig } from "swr"
import { ArrowRightLeft, Check, Crosshair, LoaderCircle, Radio } from "lucide-react"
import { Button } from "@/components/ui/button"
import { Badge } from "@/components/ui/badge"
import { CoinSelector } from "./coin-selector"
import { buildMarketUrl, findMarket, normalizeExchange } from "@/lib/coin-selector-utils"
import { isFlatForAutoSwitch } from "@/lib/trend-candidate"
import type { BotState } from "@/lib/use-bot-state"

interface Market {
  symbol: string
  displayName: string
  maxLeverage: number
}

interface MarketOptions {
  markets: Market[]
  timeframes: string[]
  exchange: string
  count: number
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
  // Exchange-aware key: switching exchange changes the URL, so SWR drops the
  // previous exchange's coin list and fetches the current one. The old static
  // "/api/bot/market" key kept showing the previous exchange's coins.
  const exchange = normalizeExchange(state.config.exchange)
  const marketUrl = buildMarketUrl(exchange)
  const { data, error: marketsError } = useSWR<MarketOptions>(marketUrl, fetcher, {
    revalidateOnFocus: false,
  })
  const [symbol, setSymbol] = useState(state.config.symbol)
  const [timeframe, setTimeframe] = useState(state.config.timeframe)
  const [leverage, setLeverage] = useState(String(state.config.leverage))
  const [positionSizeUsdt, setPositionSizeUsdt] = useState(String(state.config.positionSizeUsdt))
  const [saving, setSaving] = useState(false)
  const [scanning, setScanning] = useState(false)
  const [feedback, setFeedback] = useState<string | null>(null)

  useEffect(() => {
    setSymbol(state.config.symbol)
    setTimeframe(state.config.timeframe)
    setLeverage(String(state.config.leverage))
    setPositionSizeUsdt(String(state.config.positionSizeUsdt))
  }, [state.config.symbol, state.config.timeframe, state.config.leverage, state.config.positionSizeUsdt])

  const selectedMarket = useMemo(
    () => findMarket(data?.markets, symbol),
    [data?.markets, symbol],
  )
  // Coin changes apply instantly via the selector, so "dirty" only tracks the
  // fields that still need the Apply button.
  const dirty =
    timeframe !== state.config.timeframe ||
    Number(leverage) !== state.config.leverage ||
    Number(positionSizeUsdt) !== state.config.positionSizeUsdt

  const postMarket = async (next: { symbol: string; timeframe: string; leverage: number; positionSizeUsdt: number }) => {
    const response = await fetch("/api/bot/market", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(next),
    })
    const json = await response.json()
    if (!response.ok) throw new Error(json.error ?? "Market switch failed")
    await mutate("/api/bot/state")
  }

  const applyMarket = async () => {
    setSaving(true)
    setFeedback(null)
    try {
      await postMarket({
        symbol: (symbol || "").toUpperCase(),
        timeframe,
        leverage: Number(leverage),
        positionSizeUsdt: Number(positionSizeUsdt),
      })
      setFeedback("Market active")
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Market switch failed")
    } finally {
      setSaving(false)
    }
  }

  // Clicking a coin in the dropdown selects AND populates it immediately —
  // no second Apply click needed.
  const handleCoinSelect = async (nextSymbol: string) => {
    const s = (nextSymbol || "").toUpperCase()
    if (!s || s === (symbol || "").toUpperCase()) return
    const market = findMarket(data?.markets, s)
    // Clamp leverage to the new coin's max so the instant apply never rejects.
    const maxLev = market?.maxLeverage ?? 100
    const lev = Math.min(Number(leverage) || state.config.leverage || 1, maxLev)
    setSymbol(s)
    setLeverage(String(lev))
    setSaving(true)
    setFeedback(null)
    try {
      await postMarket({
        symbol: s,
        timeframe,
        leverage: lev,
        positionSizeUsdt: Number(positionSizeUsdt),
      })
      setFeedback(`${s.replace("_", "/")} active`)
    } catch (error) {
      setFeedback(error instanceof Error ? error.message : "Market switch failed")
    } finally {
      setSaving(false)
    }
  }

  const [autoScan, setAutoScan] = useState(
    () => typeof localStorage !== "undefined" && localStorage.getItem("findAuto") === "1",
  )
  const [autoMinutes, setAutoMinutes] = useState(() => {
    const raw = typeof localStorage !== "undefined" ? localStorage.getItem("findAutoMin") : null
    const n = Number(raw)
    return [1, 5, 15].includes(n) ? n : 5
  })
  const [autoNote, setAutoNote] = useState<string | null>(null)

  // FIND: scan the current exchange for the best trend setup and load the
  // winner straight into the coin picker (auto-applied via handleCoinSelect).
  // In auto mode the winner is only applied when fully flat — never mid-trade.
  const runScan = async (auto: boolean) => {
    if (auto && !isFlatForAutoSwitch(state)) {
      setAutoNote("skipped — position open")
      return
    }
    setScanning(true)
    if (!auto) setFeedback(null)
    try {
      const res = await fetch(`/api/bot/scan-trend?exchange=${encodeURIComponent(exchange)}&top=8`)
      const json = await res.json()
      if (!res.ok) throw new Error(json.error ?? "Trend scan failed")
      if (json.winner) {
        const w = json.winner as { symbol: string; direction: string; score: number; grade: string }
        if (auto && w.symbol.toUpperCase() === (symbol || "").toUpperCase()) {
          setAutoNote(`already on ${w.symbol.replace("_", "/")} ${w.score} (${w.grade})`)
          return
        }
        await handleCoinSelect(w.symbol)
        const msg = `${w.symbol.replace("_", "/")} ${String(w.direction).toUpperCase()} ${w.score} (${w.grade}) — best of ${json.scanned} scanned`
        if (auto) setAutoNote(`applied ${msg}`)
        else setFeedback(`FIND: ${msg}`)
      } else {
        const best = (json.scores as Array<{ symbol: string; score: number; grade: string }> | undefined)?.[0]
        const msg = best
          ? `no tradable setup right now (best ${best.symbol.replace("_", "/")} ${best.score} ${best.grade})`
          : "no candidates scored"
        if (auto) setAutoNote(msg)
        else setFeedback(`FIND: ${msg}`)
      }
    } catch (error) {
      const msg = error instanceof Error ? error.message : "Trend scan failed"
      if (auto) setAutoNote(msg)
      else setFeedback(msg)
    } finally {
      setScanning(false)
    }
  }
  const handleFind = () => runScan(false)

  // Auto-scan timer. The ref always points at the latest run so the interval
  // never acts on stale state.
  const autoRunRef = useRef<() => void>(() => {})
  autoRunRef.current = () => { void runScan(true) }
  useEffect(() => {
    if (!autoScan) return
    const id = setInterval(() => autoRunRef.current(), autoMinutes * 60_000)
    return () => clearInterval(id)
  }, [autoScan, autoMinutes])

  const toggleAutoScan = () => {
    const next = !autoScan
    setAutoScan(next)
    try {
      localStorage.setItem("findAuto", next ? "1" : "0")
    } catch { /* private mode — auto simply won't persist */ }
    if (next) {
      setAutoNote("scanning…")
      void runScan(true)
    } else {
      setAutoNote(null)
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
              <h2 className="truncate font-mono text-lg font-semibold">{(state?.config?.symbol || "UNKNOWN").replace("_", "/")}</h2>
              <Badge variant="outline" className="border-primary/40 bg-primary/15 text-primary text-[10px] px-1.5 ml-1 shrink-0">ACTIVE</Badge>
              <Badge variant="secondary">{timeframeLabel[state.config.timeframe] ?? state.config.timeframe}</Badge>
              <Badge variant="outline">{state.config.leverage}x</Badge>
              <Badge variant="outline" className="gap-1">
                <Radio aria-hidden="true" /> {(state?.config?.mode || "paper").toUpperCase()}
              </Badge>
            </div>
            <div className="flex flex-wrap items-baseline gap-2">
              <span className="font-mono text-xl font-semibold">
                {state.markPrice?.toLocaleString(undefined, { maximumFractionDigits: 6 }) ?? "—"}
              </span>
              <span className="text-xs text-muted-foreground">
                {state.ticker ? `${state.ticker.riseFallRate >= 0 ? "+" : ""}${(state.ticker.riseFallRate * 100).toFixed(2)}%` : ""}
              </span>
            </div>
          </div>
        </div>

        {/* REGIME BADGE + ADX — selected market only, not the whole bot */}
        <div className="flex items-center gap-3">
          {state.regime ? (
            <>
              <Badge
                className={`text-xs px-3 py-1.5 font-bold uppercase ${
                  state.regime === "trend"
                    ? "bg-danger/20 text-danger border-danger/40 animate-pulse shadow-[0_0_12px_var(--color-danger)]"
                    : state.regime === "range"
                    ? "bg-yellow-500/20 text-yellow-400 border-yellow-500/40 animate-pulse shadow-[0_0_12px_rgba(234,179,8,0.6)]"
                    : "bg-muted text-muted-foreground border-border"
                }`}
              >
                {state.regime === "trend" ? "TRENDING" : state.regime === "range" ? "RANGING" : "NEUTRAL"}
              </Badge>
              <span className="text-[10px] uppercase tracking-wider text-muted-foreground">selected market</span>
              {state.adxValue != null && (
                <span className="text-sm font-bold text-white font-mono tracking-wider">
                  ADX <span className="text-base">{state.adxValue.toFixed(1)}</span>
                </span>
              )}
            </>
          ) : (
            <span className="text-xs text-muted-foreground">Market data loading…</span>
          )}
        </div>

        <div className="flex flex-col gap-2 lg:flex-row lg:items-end">
          <div className="flex flex-col gap-1 text-xs text-muted-foreground">
            <span className="flex items-center justify-between gap-2">
              Scan
              <button
                type="button"
                role="switch"
                aria-checked={autoScan}
                onClick={toggleAutoScan}
                title="Auto-scan: re-scan on a timer and switch the market only when fully flat (no positions, no pending orders)"
                className={`rounded-full border px-1.5 py-px text-[10px] font-semibold transition-colors ${
                  autoScan
                    ? "border-success/50 bg-success/15 text-success"
                    : "border-border text-muted-foreground hover:text-foreground"
                }`}
              >
                AUTO {autoScan ? "ON" : "OFF"}
              </button>
            </span>
            <div className="flex items-center gap-1.5">
              <Button
                variant="outline"
                className="h-9 shrink-0 gap-1.5 px-3 font-semibold"
                disabled={saving || scanning}
                onClick={handleFind}
                title={`Scan ${exchange} for the best trend setup and load it into the picker`}
              >
                {scanning
                  ? <LoaderCircle data-icon="inline-start" className="animate-spin" />
                  : <Crosshair data-icon="inline-start" />}
                {scanning ? "…" : "FIND"}
              </Button>
              {autoScan && (
                <select
                  value={autoMinutes}
                  onChange={(event) => {
                    const n = Number(event.target.value)
                    setAutoMinutes(n)
                    try {
                      localStorage.setItem("findAutoMin", String(n))
                    } catch { /* private mode — interval simply won't persist */ }
                  }}
                  className="h-9 rounded-lg border border-input bg-background px-1.5 text-xs text-foreground outline-none focus-visible:border-ring"
                  title="Auto-scan interval"
                >
                  <option value={1}>1m</option>
                  <option value={5}>5m</option>
                  <option value={15}>15m</option>
                </select>
              )}
            </div>
            {autoScan && autoNote && (
              <span className="max-w-56 truncate text-[10px]" title={autoNote}>· {autoNote}</span>
            )}
          </div>
          <CoinSelector
            key={exchange}
            exchange={exchange}
            value={symbol}
            markets={data?.markets}
            isLoading={!data && !marketsError}
            error={marketsError}
            disabled={saving || scanning}
            onSelect={handleCoinSelect}
          />

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

          <label className="flex flex-col gap-1 text-xs text-muted-foreground">
            Budget (USDT)
            <input
              type="number"
              value={positionSizeUsdt}
              onChange={(event) => setPositionSizeUsdt(event.target.value)}
              min="0"
              step="10"
              className="h-9 min-w-24 rounded-lg border border-input bg-background px-3 text-sm text-foreground outline-none focus-visible:border-ring focus-visible:ring-3 focus-visible:ring-ring/50"
            />
            <span className="text-[10px] text-muted-foreground">risk {((state.scalpRiskPct ?? 0.01) * 100).toFixed(1)}% / trade (global)</span>
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
