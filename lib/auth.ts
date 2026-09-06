/**
 * Authentication helpers for the trading dashboard and its API.
 *
 * IMPORTANT: This module is imported by `middleware.ts`, which runs on the Edge
 * runtime. It therefore uses ONLY the Web Crypto API (`crypto.subtle`) and
 * standard web globals — no Node.js built-ins (`crypto`, `Buffer`, etc.). The
 * same helpers work unchanged inside normal (Node runtime) route handlers.
 *
 * Two authentication mechanisms are supported:
 *   1. Session cookie  — for the browser dashboard. Set after logging in with
 *      DASHBOARD_PASSWORD. The cookie holds an HMAC-signed, expiring token.
 *   2. API key header  — for programmatic/automation access
 *      (`Authorization: Bearer <API_KEY>` or `x-api-key: <API_KEY>`).
 *
 * Required environment variables (set these as Fly.io secrets):
 *   - DASHBOARD_PASSWORD : password used to log into the dashboard.
 *   - AUTH_SECRET        : (recommended) secret used to sign session cookies.
 *                          Falls back to DASHBOARD_PASSWORD if unset.
 *   - API_KEY            : (optional) key for programmatic API access.
 */
import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

export const SESSION_COOKIE = "fable_session"

// Session lifetime (seconds). Dashboard users re-authenticate after this.
export const SESSION_TTL_SECONDS = 60 * 60 * 12 // 12 hours

const encoder = new TextEncoder()
const decoder = new TextDecoder()

/** Secret used to sign session cookies. */
function getSigningSecret(): string | null {
  return process.env.AUTH_SECRET || process.env.DASHBOARD_PASSWORD || null
}

// ---------------------------------------------------------------------------
// base64url helpers (URL-safe, no padding)
// ---------------------------------------------------------------------------
function b64urlEncode(bytes: Uint8Array): string {
  let bin = ""
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i])
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "")
}

function b64urlDecode(str: string): Uint8Array {
  const pad = str.length % 4 === 0 ? "" : "=".repeat(4 - (str.length % 4))
  const bin = atob(str.replace(/-/g, "+").replace(/_/g, "/") + pad)
  const out = new Uint8Array(bin.length)
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i)
  return out
}

async function hmacSha256(secret: string, data: string): Promise<Uint8Array> {
  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"],
  )
  const sig = await crypto.subtle.sign("HMAC", key, encoder.encode(data))
  return new Uint8Array(sig)
}

/**
 * Constant-time string comparison that does not leak length or content via
 * timing. Both inputs are HMAC'd under a fresh random key, so the byte-compare
 * always runs over equal-length digests regardless of the raw input lengths.
 */
export async function safeEqual(a: string, b: string): Promise<boolean> {
  const randomKey = b64urlEncode(crypto.getRandomValues(new Uint8Array(32)))
  const [ha, hb] = await Promise.all([hmacSha256(randomKey, a), hmacSha256(randomKey, b)])
  // Digests are always 32 bytes; compare in constant time.
  let diff = a.length === b.length ? 0 : 1
  for (let i = 0; i < ha.length; i++) diff |= ha[i] ^ hb[i]
  return diff === 0
}

// ---------------------------------------------------------------------------
// Session tokens (signed, expiring) — used for the dashboard cookie
// ---------------------------------------------------------------------------
interface SessionPayload {
  iat: number // issued-at (ms)
  exp: number // expiry (ms)
}

/** Create a signed session token. Returns null if no signing secret is set. */
export async function createSessionToken(ttlSeconds = SESSION_TTL_SECONDS): Promise<string | null> {
  const secret = getSigningSecret()
  if (!secret) return null
  const now = Date.now()
  const payload: SessionPayload = { iat: now, exp: now + ttlSeconds * 1000 }
  const body = b64urlEncode(encoder.encode(JSON.stringify(payload)))
  const sig = b64urlEncode(await hmacSha256(secret, body))
  return `${body}.${sig}`
}

/** Verify a session token's signature and expiry. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false
  const secret = getSigningSecret()
  if (!secret) return false

  const parts = token.split(".")
  if (parts.length !== 2) return false
  const [body, sig] = parts

  const expectedSig = b64urlEncode(await hmacSha256(secret, body))
  if (!(await safeEqual(sig, expectedSig))) return false

  try {
    const payload = JSON.parse(decoder.decode(b64urlDecode(body))) as SessionPayload
    if (typeof payload.exp !== "number") return false
    if (Date.now() > payload.exp) return false
    return true
  } catch {
    return false
  }
}

// ---------------------------------------------------------------------------
// API-key header verification — used for programmatic/automation access
// ---------------------------------------------------------------------------
function extractApiKey(request: NextRequest | Request): string {
  const authHeader = request.headers.get("authorization")
  if (authHeader && authHeader.toLowerCase().startsWith("bearer ")) {
    return authHeader.slice(7).trim()
  }
  return (request.headers.get("x-api-key") || "").trim()
}

/** True if the request carries a valid programmatic API key. */
export async function verifyApiKeyHeader(request: NextRequest | Request): Promise<boolean> {
  const apiKey = process.env.API_KEY
  if (!apiKey) return false // fail closed: no key configured => header auth disabled
  const provided = extractApiKey(request)
  if (!provided) return false
  return safeEqual(provided, apiKey)
}

/** Read the session cookie value from a request (works with NextRequest or Request). */
function readSessionCookie(request: NextRequest | Request): string | undefined {
  // NextRequest exposes a typed cookie jar.
  const anyReq = request as NextRequest
  if (anyReq.cookies && typeof anyReq.cookies.get === "function") {
    return anyReq.cookies.get(SESSION_COOKIE)?.value
  }
  // Fallback: parse the raw Cookie header.
  const cookieHeader = request.headers.get("cookie") || ""
  const match = cookieHeader.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`))
  return match ? decodeURIComponent(match[1]) : undefined
}

/**
 * True if the request is authenticated by EITHER a valid API key header OR a
 * valid dashboard session cookie.
 */
export async function isAuthenticated(request: NextRequest | Request): Promise<boolean> {
  if (await verifyApiKeyHeader(request)) return true
  if (await verifySessionToken(readSessionCookie(request))) return true
  return false
}

/**
 * Defense-in-depth guard for use directly inside sensitive route handlers.
 * Returns a 401 `NextResponse` when unauthenticated, or `null` when the caller
 * may proceed. The central `middleware.ts` already protects these routes; this
 * is a belt-and-suspenders check for the highest-risk (money-moving) endpoints.
 */
export async function requireAuth(request: NextRequest | Request): Promise<NextResponse | null> {
  if (await isAuthenticated(request)) return null
  return NextResponse.json(
    { error: "Unauthorized - valid session or API key required" },
    { status: 401, headers: { "WWW-Authenticate": "Bearer" } },
  )
}
