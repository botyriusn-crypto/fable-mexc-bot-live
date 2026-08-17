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
  // Multi-grid / rotation / shadow fields returned by /api/bot/state (optional; absent in fallback)
  gridConfigs?: Array<{
    symbol: string
    timeframe: string
    enabled: boolean
    paused: boolean
    levels: number
    effectiveLevels: number
    spacing: number | null
    buyCount: number
    sellCount: number
    unrealizedPnl: number
    realizedPnl: number
    budgetPct: number
    leverage: number
    gridLeverage?: number
    atrMult?: number
    makerMode?: boolean
    direction: string
  }>
  rotationEnabled?: boolean
  lastRotationTime?: number
  shadowStats?: {
    totalEvaluations: number
    resolvedCount: number
    correctCount: number
    accuracy: number
    topCandidate: {
      symbol: string
      direction: string
      createdAt: string
      [key: string]: unknown
    } | null
  } | null
  sniperModel?: unknown
  watchdog?: unknown
  liveStats?: unknown
  todayStats?: unknown
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
    fallbackData: {
      config: { status: "stopped", mode: "paper", exchange: "mexc" },
      openPosition: null,
      openPositions: [],
      exposures: [],
      managedMarkets: [],
      markPrice: null,
      unrealizedPnl: 0,
      equity: 0,
      trades: [],
      winRate: 0,
      equityCurve: [],
      logs: [],
      model: null,
      aiAdvisorEnabled: false,
      aiAnalysisSchedule: "manual",
      aiLastAnalysis: null,
      classifierAnalytics: {
        sampleCount: 0,
        resolvedCount: 0,
        acceptedCount: 0,
        rejectedCount: 0,
        agreementRate: null,
        logisticAccuracy: null,
        lorentzianAccuracy: null,
        latest: null
      },
      ticker: null,
      chart: [],
      liveAccount: null,
      regime: null,
      adxValue: null,
      grid: {
        orders: [],
        holdingCount: 0,
        unrealizedPnl: 0,
        realizedPnl: 0
      }
    } as unknown as BotState,
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
