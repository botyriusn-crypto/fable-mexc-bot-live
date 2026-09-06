import { describe, expect, it, beforeEach, afterEach } from "vitest"
import {
  safeEqual,
  createSessionToken,
  verifySessionToken,
  verifyApiKeyHeader,
  isAuthenticated,
  SESSION_COOKIE,
} from "./auth"

const OLD_ENV = { ...process.env }

beforeEach(() => {
  process.env.AUTH_SECRET = "test-signing-secret"
  process.env.DASHBOARD_PASSWORD = "dash-pass"
  process.env.API_KEY = "super-secret-api-key"
})

afterEach(() => {
  process.env = { ...OLD_ENV }
})

describe("safeEqual", () => {
  it("returns true for identical strings", async () => {
    expect(await safeEqual("hunter2", "hunter2")).toBe(true)
  })

  it("returns false for different strings of same length", async () => {
    expect(await safeEqual("hunter2", "hunterX")).toBe(false)
  })

  it("returns false for strings of different length", async () => {
    expect(await safeEqual("short", "a-much-longer-value")).toBe(false)
  })

  it("handles empty strings", async () => {
    expect(await safeEqual("", "")).toBe(true)
    expect(await safeEqual("", "x")).toBe(false)
  })
})

describe("session tokens", () => {
  it("creates and verifies a valid token", async () => {
    const token = await createSessionToken()
    expect(token).toBeTruthy()
    expect(await verifySessionToken(token)).toBe(true)
  })

  it("rejects a tampered token body", async () => {
    const token = (await createSessionToken())!
    const [body, sig] = token.split(".")
    const tampered = `${body}x.${sig}`
    expect(await verifySessionToken(tampered)).toBe(false)
  })

  it("rejects a tampered signature", async () => {
    const token = (await createSessionToken())!
    const [body] = token.split(".")
    expect(await verifySessionToken(`${body}.deadbeef`)).toBe(false)
  })

  it("rejects an expired token", async () => {
    const token = await createSessionToken(-1) // already expired
    expect(await verifySessionToken(token)).toBe(false)
  })

  it("rejects a token signed with a different secret", async () => {
    const token = (await createSessionToken())!
    process.env.AUTH_SECRET = "a-different-secret"
    expect(await verifySessionToken(token)).toBe(false)
  })

  it("rejects malformed tokens", async () => {
    expect(await verifySessionToken(undefined)).toBe(false)
    expect(await verifySessionToken("")).toBe(false)
    expect(await verifySessionToken("no-dot")).toBe(false)
    expect(await verifySessionToken("a.b.c")).toBe(false)
  })

  it("returns null when no signing secret is configured", async () => {
    delete process.env.AUTH_SECRET
    delete process.env.DASHBOARD_PASSWORD
    expect(await createSessionToken()).toBeNull()
  })
})

function reqWithHeaders(headers: Record<string, string>): Request {
  return new Request("http://localhost/api/bot/control", { headers })
}

describe("verifyApiKeyHeader", () => {
  it("accepts a valid Bearer token", async () => {
    expect(await verifyApiKeyHeader(reqWithHeaders({ authorization: "Bearer super-secret-api-key" }))).toBe(true)
  })

  it("accepts a valid x-api-key header", async () => {
    expect(await verifyApiKeyHeader(reqWithHeaders({ "x-api-key": "super-secret-api-key" }))).toBe(true)
  })

  it("rejects a wrong key", async () => {
    expect(await verifyApiKeyHeader(reqWithHeaders({ authorization: "Bearer wrong" }))).toBe(false)
  })

  it("rejects when no header present", async () => {
    expect(await verifyApiKeyHeader(reqWithHeaders({}))).toBe(false)
  })

  it("fails closed when API_KEY is not configured", async () => {
    delete process.env.API_KEY
    expect(await verifyApiKeyHeader(reqWithHeaders({ authorization: "Bearer anything" }))).toBe(false)
  })
})

describe("isAuthenticated", () => {
  it("is true with a valid API key", async () => {
    expect(await isAuthenticated(reqWithHeaders({ "x-api-key": "super-secret-api-key" }))).toBe(true)
  })

  it("is true with a valid session cookie", async () => {
    const token = (await createSessionToken())!
    expect(await isAuthenticated(reqWithHeaders({ cookie: `${SESSION_COOKIE}=${token}` }))).toBe(true)
  })

  it("is false with neither", async () => {
    expect(await isAuthenticated(reqWithHeaders({}))).toBe(false)
  })

  it("is false with an invalid session cookie", async () => {
    expect(await isAuthenticated(reqWithHeaders({ cookie: `${SESSION_COOKIE}=bogus.token` }))).toBe(false)
  })
})
