"use client"

import React, { useEffect, useState } from "react"

interface CoinStatus {
  symbol: string
  trend: "up" | "down" | "neutral"
  volSurge: number
  sweepPotential: "hot" | "warm" | "cold"
  lastWick: number
}

interface SniperReadinessData {
  score: number
  label: string
  sweepProb: number
  volPulse: number
  trendingCount: number
  topCoins: CoinStatus[]
  forecast: number[]
  lastUpdate: string
}

export default function SniperReadinessGauge() {
  const [data, setData] = useState<SniperReadinessData | null>(null)
  const [loading, setLoading] = useState(true)
  const [failed, setFailed] = useState(false)

  useEffect(() => {
    async function fetchStatus() {
      try {
        const res = await fetch("/api/sniper-status")
        if (!res.ok) throw new Error("Failed to fetch")
        const json = await res.json()
        setData(json)
        setFailed(false)
      } catch {
        // Never render invented coins: a failed scan shows an error state.
        setFailed(true)
      } finally {
        setLoading(false)
      }
    }

    fetchStatus()
    const interval = setInterval(fetchStatus, 30000)
    return () => clearInterval(interval)
  }, [])

  if (loading) {
    return (
      <div className="rounded-xl border border-white/10 bg-[#0f1115] p-4 animate-pulse">
        <div className="h-4 w-32 bg-white/10 rounded mb-4" />
        <div className="h-24 w-full bg-white/5 rounded" />
      </div>
    )
  }

  if (failed || !data) {
    return (
      <div className="rounded-xl border border-danger/40 bg-[#0f1115] p-4">
        <div className="text-white font-medium text-base mb-1">Sniper readiness</div>
        <div className="text-[13px] text-white/60 leading-5">
          Scan unavailable — /api/sniper-status failed. Showing nothing rather than stale data.
        </div>
      </div>
    )
  }

  const scoreColor = data.score >= 70 ? "text-emerald-400" : data.score >= 40 ? "text-amber-400" : "text-rose-400"
  const circumference = 2 * Math.PI * 40
  const dashOffset = circumference - (data.score / 100) * circumference

  return (
    <div className="rounded-xl border border-white/10 bg-[#0f1115] p-4">
      <div className="flex items-center gap-2 mb-4">
        <svg width="20" height="20" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="1.8" className="text-white">
          <circle cx="12" cy="12" r="10" />
          <path d="M12 6v6l4 2" />
        </svg>
        <span className="text-white font-medium text-base">Sniper readiness</span>
        <span className="ml-auto text-xs text-white/40">
          {Math.round((Date.now() - new Date(data.lastUpdate).getTime()) / 60000)}m ago
        </span>
      </div>

      <div className="flex items-center gap-4 mb-5">
        <div className="relative w-24 h-24 flex-shrink-0">
          <svg width="96" height="96" viewBox="0 0 96 96" className="-rotate-90">
            <circle cx="48" cy="48" r="40" fill="none" stroke="rgba(255,255,255,0.08)" strokeWidth="8" />
            <circle
              cx="48" cy="48" r="40"
              fill="none"
              stroke="currentColor"
              strokeWidth="8"
              strokeLinecap="round"
              className={scoreColor}
              strokeDasharray={circumference}
              strokeDashoffset={dashOffset}
              style={{ transition: "stroke-dashoffset 0.5s ease-out" }}
            />
          </svg>
          <div className="absolute inset-0 flex flex-col items-center justify-center">
            <span className={`text-3xl font-medium ${scoreColor} tabular-nums`}>{data.score}</span>
            <span className="text-[11px] text-white/40">of 100</span>
          </div>
        </div>
        <div className="flex-1 min-w-0">
          <div className={`text-sm font-medium ${scoreColor} mb-1`}>{data.label}</div>
          <div className="text-[13px] text-white/60 leading-5">
            {data.sweepProb === 0
              ? `No sweep patterns across 50 scanned coins. Volume pulse at ${data.volPulse}%. Wait for volatility.`
              : `${Math.round(data.sweepProb * 0.5)} sweep candidates detected. Volume pulse at ${data.volPulse}%.`}
          </div>
        </div>
      </div>

      <div className="grid grid-cols-3 gap-2 mb-4">
        <MetricBox label="Sweep prob" value={`${data.sweepProb}%`} sub={`${Math.round(data.sweepProb * 0.5)} / 50 coins`} color={data.sweepProb >= 30 ? "text-emerald-400" : data.sweepProb >= 10 ? "text-amber-400" : "text-rose-400"} />
        <MetricBox label="Volume pulse" value={`${data.volPulse}%`} sub={`${Math.round(data.volPulse * 0.5)} above 1.2x`} color={data.volPulse >= 40 ? "text-emerald-400" : data.volPulse >= 20 ? "text-amber-400" : "text-white/60"} />
        <MetricBox label="Trending" value={String(data.trendingCount)} sub="up / down" color="text-white" />
      </div>

      <div className="border border-white/10 rounded-lg overflow-hidden mb-4">
        <div className="px-3 py-2 text-xs font-medium text-white/50 bg-white/[0.03]">Top 5 by sweep potential</div>
        {data.topCoins.map((coin) => (
          <div key={coin.symbol} className="px-3 py-2 flex justify-between items-center border-b border-white/[0.05] last:border-0">
            <span className="text-[13px] text-white font-medium">{coin.symbol}</span>
            <span className="text-xs text-white/40">{coin.trend} · vol {coin.volSurge.toFixed(1)}x</span>
            <span className={`text-[11px] px-2 py-0.5 rounded-md ${potentialStyle(coin.sweepPotential)}`}>{coin.sweepPotential}</span>
          </div>
        ))}
      </div>

      <div className="border border-white/10 rounded-lg p-3">
        <div className="flex justify-between items-center mb-2">
          <span className="text-xs font-medium text-white/60">Next 2h forecast</span>
          <span className="text-[11px] text-white/30">based on session history</span>
        </div>
        <div className="flex gap-1 h-6 items-end">
          {data.forecast.map((bar, i) => {
            const barColor = bar >= 70 ? "bg-emerald-400" : bar >= 40 ? "bg-amber-400" : "bg-white/10"
            return <div key={i} className={`flex-1 rounded-sm ${barColor} transition-all duration-500`} style={{ height: `${bar}%` }} />
          })}
        </div>
        <div className="flex justify-between mt-1">
          {["now", "+30m", "+1h", "+1.5h", "+2h", "+2.5h"].map((t) => (
            <span key={t} className="text-[10px] text-white/30">{t}</span>
          ))}
        </div>
      </div>
    </div>
  )
}

function MetricBox({ label, value, sub, color }: { label: string; value: string; sub: string; color: string }) {
  return (
    <div className="border border-white/10 rounded-lg p-3 text-center">
      <div className="text-[11px] text-white/40 mb-1">{label}</div>
      <div className={`text-2xl font-medium ${color} tabular-nums`}>{value}</div>
      <div className="text-[11px] text-white/30">{sub}</div>
    </div>
  )
}

function potentialStyle(p: string) {
  if (p === "hot") return "bg-rose-400/15 text-rose-400"
  if (p === "warm") return "bg-amber-400/15 text-amber-400"
  return "bg-white/5 text-white/30"
}
