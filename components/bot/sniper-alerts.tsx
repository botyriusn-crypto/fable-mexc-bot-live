"use client"
import { useEffect, useState } from "react"
import { useBotState } from "@/lib/use-bot-state"
import { Card, CardContent } from "@/components/ui/card"
import { Button } from "@/components/ui/button"
import { Switch } from "@/components/ui/switch"

const LS_ENABLED = "sniperAlertsEnabled"
const LS_THRESHOLD = "sniperThreshold"
const LS_DISMISSED = "sniperDismissed"
const COOLDOWN_MS = 60 * 60 * 1000 // 1h per symbol+direction

function readLS(key: string, def: string): string {
  if (typeof window === "undefined") return def
  try { return window.localStorage.getItem(key) ?? def } catch { return def }
}
function writeLS(key: string, val: string) {
  if (typeof window === "undefined") return
  try { window.localStorage.setItem(key, val) } catch {}
}

// Control block that lives at the top of Strategy Settings
export function SniperCommand({ state }: { state: any }) {
  const [enabled, setEnabled] = useState(readLS(LS_ENABLED, "true") === "true")
  const [threshold, setThreshold] = useState(Number(readLS(LS_THRESHOLD, "0.55")))
  const top = state?.sniperStats?.topCandidate

  useEffect(() => { writeLS(LS_ENABLED, String(enabled)); window.dispatchEvent(new Event("sniper-config")) }, [enabled])
  useEffect(() => { writeLS(LS_THRESHOLD, String(threshold)); window.dispatchEvent(new Event("sniper-config")) }, [threshold])

  const testAlert = () => {
    window.dispatchEvent(new CustomEvent("sniper-test", { detail: { symbol: "TEST_USDT", direction: "long", confidence: 0.72, createdAt: new Date().toISOString() } }))
  }

  return (
    <div className="flex flex-col gap-3 rounded-md border border-yellow-400/40 bg-yellow-400/5 p-3">
      <div className="flex items-center justify-between">
        <div>
          <span className="text-sm font-bold text-yellow-300">🎯 Sniper Alerts</span>
          <p className="text-xs text-yellow-200/70">Floating bubble when a high-confidence candidate appears.</p>
        </div>
        <Switch checked={enabled} onCheckedChange={setEnabled} />
      </div>
      <div className="flex flex-col gap-1">
        <span className="text-xs text-yellow-200/80">Alert threshold: {(threshold * 100).toFixed(0)}%</span>
        <input type="range" min={0.5} max={0.8} step={0.01} value={threshold}
          onChange={(e) => setThreshold(Number(e.target.value))} className="accent-yellow-400" />
      </div>
      <div className="flex items-center justify-between text-xs text-yellow-200/70">
        <span>Current top: {top ? `${top.symbol} ${top.direction} (${(top.confidence * 100).toFixed(0)}%)` : "none"}</span>
        <Button size="sm" variant="outline" className="h-6 px-2 text-xs" onClick={testAlert}>Test bubble</Button>
      </div>
    </div>
  )
}

// Floating bubble that pulses until clicked
export function SniperAlertBubble() {
  const { data: state } = useBotState()
  const [enabled, setEnabled] = useState(true)
  const [threshold, setThreshold] = useState(0.55)
  const [open, setOpen] = useState(false)
  const [timeAgo, setTimeAgo] = useState("")
  const [elapsedSeconds, setElapsedSeconds] = useState(0)
  const [test, setTest] = useState<any>(null)
  const [dismissed, setDismissed] = useState<Record<string, number>>({})

  useEffect(() => {
    const sync = () => {
      setEnabled(readLS(LS_ENABLED, "true") === "true")
      setThreshold(Number(readLS(LS_THRESHOLD, "0.55")))
      try { setDismissed(JSON.parse(readLS(LS_DISMISSED, "{}"))) } catch { setDismissed({}) }
    }
    sync()
    const onTest = (e: any) => { setTest(e.detail); setOpen(true); setTimeout(() => setTest(null), 6000) }
    window.addEventListener("sniper-config", sync)
    window.addEventListener("sniper-test", onTest)
    return () => { window.removeEventListener("sniper-config", sync); window.removeEventListener("sniper-test", onTest) }
  }, [])

  const top = test ?? state?.sniperStats?.topCandidate
  const key = top ? `${top.symbol}-${top.direction}` : ""
  const inCooldown = Boolean(key && dismissed[key] && (Date.now() - dismissed[key] < COOLDOWN_MS))
  
  useEffect(() => {
    if (!top?.createdAt) { setTimeAgo(""); setElapsedSeconds(0); return }
    const update = () => {
      const diff = Math.floor((Date.now() - new Date(top.createdAt).getTime()) / 1000)
      setElapsedSeconds(diff)
      if (diff < 60) setTimeAgo(`${diff}s`)
      else setTimeAgo(`${Math.floor(diff / 60)}:${String(diff % 60).padStart(2, "0")}`)
    }
    update()
    const id = setInterval(update, 1000)
    return () => clearInterval(id)
  }, [top?.createdAt])

  const active = Boolean(enabled && top && top.confidence >= threshold && !inCooldown)

  const acknowledge = () => {
    const next = { ...dismissed, [key]: Date.now() }
    setDismissed(next); writeLS(LS_DISMISSED, JSON.stringify(next))
    window.dispatchEvent(new Event("sniper-config"))
    setOpen(false)
  }

  const isStale = elapsedSeconds > 600 // dim after 10 minutes

  if (!active) return null

  return (
    <div className="fixed bottom-4 right-4 z-50">
      {!open ? (
        <button onClick={() => setOpen(true)}
          className={`rounded-full border-2 border-yellow-400 bg-yellow-400/20 px-4 py-3 text-sm font-bold text-yellow-300 backdrop-blur transition-all duration-500 ${isStale ? "opacity-40 grayscale" : "animate-pulse shadow-[0_0_20px_rgba(250,204,21,0.5)]"}`}>
          🎯 {top.symbol} {(top?.direction || "unknown").toUpperCase()} {(top.confidence * 100).toFixed(0)}% · SNIPER{timeAgo ? ` · ${timeAgo}` : ""}
        </button>
      ) : (
        <Card className={`w-72 transition-all duration-500 ${isStale ? "border-yellow-400/20 bg-black/60 opacity-50 grayscale" : "border-yellow-400/60 bg-black/90 shadow-[0_0_24px_rgba(250,204,21,0.4)]"}`}>
          <CardContent className="flex flex-col gap-2 p-3">
            <span className="text-sm font-bold text-yellow-300">🎯 Sniper Candidate</span>
            <div className="font-mono text-lg text-yellow-200">{top.symbol} <span className={top.direction === "long" ? "text-success" : "text-danger"}>{(top?.direction || "unknown").toUpperCase()}</span></div>
            <div className="text-xs text-yellow-200/80">Confidence: {(top.confidence * 100).toFixed(0)}% · Source: Sniper rule</div>
            {timeAgo && <div className="text-[10px] font-mono text-yellow-200/60">⏱ Detected {timeAgo} ago</div>}
            <div className="text-[10px] text-yellow-200/60">Sniper rule flagged this setup. Review the pair before entering manually.</div>
            <div className="flex gap-2">
              <Button size="sm" variant="outline" className="flex-1 text-xs" onClick={() => setOpen(false)}>Keep watching</Button>
              <Button size="sm" className="flex-1 bg-yellow-400 text-black text-xs" onClick={acknowledge}>Acknowledge</Button>
            </div>
          </CardContent>
        </Card>
      )}
    </div>
  )
}
