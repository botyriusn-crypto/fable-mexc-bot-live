import { NextResponse } from "next/server"
import { runWebhookSignal } from "@/lib/engine"

export const dynamic = "force-dynamic"
export const maxDuration = 60

// External signal trigger (TradingView alerts, custom scripts, etc.)
//
// POST /api/bot/webhook
// Body (JSON): { "password": "<WEBHOOK_PASSWORD>", "action": "tick" | "long" | "short" | "close" }
//
// - "tick"  → run the normal bot tick immediately (indicators + ML decide)
// - "long"  → open a long now (still passes the ML confidence gate)
// - "short" → open a short now (still passes the ML confidence gate)
// - "close" → close the open position at market
//
// TradingView alert message example:
//   { "password": "your-password", "action": "long" }

const VALID_ACTIONS = ["tick", "long", "short", "close"] as const
type WebhookAction = (typeof VALID_ACTIONS)[number]

export async function POST(request: Request) {
  const secret = process.env.WEBHOOK_PASSWORD
  if (!secret) {
    return NextResponse.json({ error: "WEBHOOK_PASSWORD is not configured" }, { status: 503 })
  }

  let body: { password?: string; action?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  // Constant-time-ish comparison to avoid trivial timing attacks
  const provided = String(body.password ?? "")
  if (provided.length !== secret.length || !timingSafeEqual(provided, secret)) {
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }

  const action = String(body.action ?? "tick") as WebhookAction
  if (!VALID_ACTIONS.includes(action)) {
    return NextResponse.json(
      { error: `Invalid action. Use one of: ${VALID_ACTIONS.join(", ")}` },
      { status: 400 },
    )
  }

  const result = await runWebhookSignal(action)
  return NextResponse.json(result)
}

function timingSafeEqual(a: string, b: string): boolean {
  let diff = 0
  for (let i = 0; i < a.length; i++) {
    diff |= a.charCodeAt(i) ^ b.charCodeAt(i)
  }
  return diff === 0
}
