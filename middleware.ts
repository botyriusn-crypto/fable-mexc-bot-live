/**
 * Central authentication choke point.
 *
 * Every request to a page or API route passes through here (except static
 * assets — see `config.matcher` below). This guarantees that NO API route can
 * be accidentally left unauthenticated: protection is enforced in one place
 * rather than per-file.
 *
 * Access is granted when the request has EITHER:
 *   - a valid dashboard session cookie (set via /api/auth/login), OR
 *   - a valid programmatic API key (Authorization: Bearer / x-api-key).
 *
 * Exceptions (allowed through without the above):
 *   - /login and the auth endpoints (otherwise you could never log in).
 *   - /api/bot/webhook — it has its own shared-password authentication for
 *     external services such as TradingView alerts.
 */
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"
import { verifyApiKeyHeader, verifySessionToken, SESSION_COOKIE } from "@/lib/auth"

// Paths that must remain reachable without a session/API key.
const PUBLIC_PATHS = new Set<string>([
  "/login",
])

const PUBLIC_API_PATHS = new Set<string>([
  "/api/auth/login",
  "/api/auth/logout",
  "/api/bot/webhook", // own shared-password auth (external signal sources)
])

function isStaticAsset(pathname: string): boolean {
  if (pathname.startsWith("/_next")) return true
  return /\.(png|jpg|jpeg|gif|svg|ico|css|js|map|txt|webp|woff2?|ttf)$/i.test(pathname)
}

export async function middleware(request: NextRequest) {
  const { pathname } = request.nextUrl

  // Always allow static assets and explicitly-public paths.
  if (isStaticAsset(pathname)) return NextResponse.next()
  if (PUBLIC_PATHS.has(pathname)) return NextResponse.next()
  if (PUBLIC_API_PATHS.has(pathname)) return NextResponse.next()

  const isApi = pathname.startsWith("/api/")

  // Authenticated via programmatic key or dashboard session?
  const authed =
    (await verifyApiKeyHeader(request)) ||
    (await verifySessionToken(request.cookies.get(SESSION_COOKIE)?.value))

  if (authed) return NextResponse.next()

  if (isApi) {
    return NextResponse.json(
      { error: "Unauthorized - valid session or API key required" },
      { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
    )
  }

  // Unauthenticated page request → send to the login screen, preserving target.
  const loginUrl = request.nextUrl.clone()
  loginUrl.pathname = "/login"
  loginUrl.search = ""
  if (pathname && pathname !== "/") loginUrl.searchParams.set("next", pathname)
  return NextResponse.redirect(loginUrl)
}

export const config = {
  // Run on everything except Next internals and the favicon. We still filter
  // static assets inside the middleware for extra safety.
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
}
