import { NextResponse } from "next/server"
import { safeEqual, createSessionToken, SESSION_COOKIE, SESSION_TTL_SECONDS } from "@/lib/auth"

export const dynamic = "force-dynamic"

/**
 * POST /api/auth/login
 * Body: { "password": "<DASHBOARD_PASSWORD>" }
 *
 * On success sets an httpOnly, signed session cookie and returns { ok: true }.
 */
export async function POST(request: Request) {
  const dashboardPassword = process.env.DASHBOARD_PASSWORD
  if (!dashboardPassword) {
    return NextResponse.json(
      { error: "DASHBOARD_PASSWORD is not configured on the server" },
      { status: 503 },
    )
  }

  let body: { password?: string }
  try {
    body = await request.json()
  } catch {
    return NextResponse.json({ error: "Invalid JSON body" }, { status: 400 })
  }

  const provided = String(body.password ?? "")
  if (!(await safeEqual(provided, dashboardPassword))) {
    return NextResponse.json({ error: "Invalid password" }, { status: 401 })
  }

  const token = await createSessionToken()
  if (!token) {
    return NextResponse.json(
      { error: "Server signing secret (AUTH_SECRET/DASHBOARD_PASSWORD) is not configured" },
      { status: 503 },
    )
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set(SESSION_COOKIE, token, {
    httpOnly: true,
    secure: process.env.NODE_ENV === "production",
    sameSite: "lax",
    path: "/",
    maxAge: SESSION_TTL_SECONDS,
  })
  return res
}
