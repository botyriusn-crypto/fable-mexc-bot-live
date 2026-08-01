"use client"

import useSWR from "swr"
import type { BotConfig, Position, Trade, MlModelRow, GridOrder } from "./db/schema"

export interface BotState {
  config: BotConfig
  openPosition: Position | null
  openPositions: Position[]
  exposures: Array<{
    position: Position
    markPrice: number | null
    unrealizedPnl: number
    selected: boolean
  }>
  managedMarkets: Array<{
    symbol: string
    timeframe: string
    positionCount: number
    gridOrderCount: number
    selected: boolean
  }>
  markPrice: number | null
  unrealizedPnl: number
  equity: number
  trades: Trade[]
  winRate: number
  equityCurve: { id: number; balance: number; equity: number; unrealizedPnl: number; createdAt: string }[]
  logs: { id: number; level: string; message: string; createdAt: string }[]
  model: MlModelRow | null
  aiAdvisorEnabled: boolean
  aiAnalysisSchedule: string
  aiLastAnalysis: string | null
  classifierAnalytics: {
    sampleCount: number
    resolvedCount: number
    acceptedCount: number
    rejectedCount: number
    agreementRate: number | null
    logisticAccuracy: number | null
    lorentzianAccuracy: number | null
    latest: {
      candidateDirection: string
      logisticConfidence: number
      lorentzianDirection: string
      lorentzianConfidence: number
      lorentzianVote: number
      reason: string
      createdAt: string
    } | null
  }
  ticker: { lastPrice: number; fundingRate: number; riseFallRate: number } | null
  chart: { time: number; close: number; emaFast: number; emaSlow: number }[]
  liveAccount:
    | { availableBalance: number; equity: number; unrealized: number; positionMargin: number }
    | { error: string }
    | null
  regime: "trend" | "range" | "neutral" | null
  adxValue: number | null
  grid: {
    orders: GridOrder[]
    holdingCount: number
    unrealizedPnl: number
    realizedPnl: number
  }
}

const fetcher = async (url: string) => {
  const res = await fetch(url)
  if (!res.ok) throw new Error("Failed to fetch bot state")
  return res.json()
}

export function useBotState() {
  return useSWR<BotState>("/api/bot/state", fetcher, {
    refreshInterval: 5000,
    revalidateOnFocus: true,
  })
}

export async function botAction(action: string, extra?: Record<string, unknown>) {
  const res = await fetch("/api/bot/control", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ action, ...extra }),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? "Action failed")
  return json
}

export async function updateConfig(updates: Record<string, unknown>) {
  const res = await fetch("/api/bot/config", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(updates),
  })
  const json = await res.json()
  if (!res.ok) throw new Error(json.error ?? "Config update failed")
  return json
}
