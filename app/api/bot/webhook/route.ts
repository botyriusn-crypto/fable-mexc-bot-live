import { NextResponse } from "next/server"
import { runWebhookSignal } from "@/lib/engine"
import crypto from "crypto"

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

  // Constant-time comparison using Node.js crypto module
  const provided = String(body.password ?? "")
  // Handle length mismatch safely by comparing with a dummy value first
  if (provided.length !== secret.length) {
    // Use a dummy string of same length to avoid timing leak on length check
    crypto.timingSafeEqual(Buffer.from(provided.padEnd(secret.length, '\0')), Buffer.from(secret))
    return NextResponse.json({ error: "Unauthorized" }, { status: 401 })
  }
  if (!crypto.timingSafeEqual(Buffer.from(provided), Buffer.from(secret))) {
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
