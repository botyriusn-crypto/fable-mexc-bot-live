import { afterEach, beforeEach, describe, expect, it, vi } from "vitest"
import { checkMigrateSource, parseAllowedHosts } from "./migrate-guard"
import { canOpenNewPosition, marginBudgetRemaining } from "./risk-manager"
import { roundMexcQuantity, ensureSpecsLoaded } from "./mexc/precision"

// Hardening round 2 — regression tests for three independent safety fixes:
//   FIX 1  migrate endpoint SSRF host allowlist (fail closed)
//   FIX 2  risk-manager fail-closed defaults when state is uncomputed
//   FIX 3  MEXC order sizing floors contracts + refuses unverified specs

// ── FIX 1: migrate SSRF allowlist ──────────────────────────────────────────
describe("migrate SSRF allowlist", () => {
  const url = "postgres://user:pass@db.allowed.example.com:5432/mydb"

  it("allows a source host that is in MIGRATE_ALLOWED_HOSTS", () => {
    const r = checkMigrateSource(url, "db.allowed.example.com,other.example.com")
    expect(r.ok).toBe(true)
    if (r.ok) expect(r.host).toBe("db.allowed.example.com")
  })

  it("blocks a source host that is NOT in the allowlist (403)", () => {
    const r = checkMigrateSource(
      "postgres://user:pass@evil.internal:5432/db",
      "db.allowed.example.com",
    )
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it("blocks ALL hosts when the env var is unset (fail closed, 403)", () => {
    const r = checkMigrateSource(url, undefined)
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(403)
  })

  it("blocks ALL hosts when the env var is empty/whitespace (fail closed)", () => {
    expect(checkMigrateSource(url, "").ok).toBe(false)
    expect(checkMigrateSource(url, "   , ,").ok).toBe(false)
  })

  it("rejects a non-postgres / malformed source url (400)", () => {
    const r = checkMigrateSource("http://db.allowed.example.com", "db.allowed.example.com")
    expect(r.ok).toBe(false)
    if (!r.ok) expect(r.status).toBe(400)
  })

  it("parses and normalizes the host list (trim + lowercase)", () => {
    expect(parseAllowedHosts(" A.com , B.COM ,,")).toEqual(["a.com", "b.com"])
    expect(parseAllowedHosts(undefined)).toEqual([])
  })
})

// ── FIX 2: risk-manager fail-closed defaults ────────────────────────────────
describe("risk-manager fail-safe (no computed state)", () => {
  // On a fresh module load evaluatePortfolioRisk() has never run, so the cached
  // _state is null. Both accessors must fail CLOSED rather than assume it is
  // safe to add risk.
  it("canOpenNewPosition() returns false when state is null", () => {
    expect(canOpenNewPosition()).toBe(false)
  })

  it("marginBudgetRemaining() returns 0 (not Infinity) when state is null", () => {
    expect(marginBudgetRemaining()).toBe(0)
  })
})

// ── FIX 3: MEXC order sizing ────────────────────────────────────────────────
describe("MEXC precision floors contract quantity", () => {
  // BTC_USDT contractSize is 0.0001 in both the live MEXC data and the
  // hardcoded KNOWN_SPECS fallback, so this is deterministic with or without
  // network access.
  it("floors down instead of rounding (1.7 contracts -> 1)", () => {
    // 0.00017 / 0.0001 = 1.7  -> floor = 1  (Math.round would give 2)
    expect(roundMexcQuantity("BTC_USDT", 50000, 0.00017)).toBe(1)
  })

  it("floors 2.9 contracts -> 2 (round would give 3)", () => {
    // 0.00029 / 0.0001 = 2.9 -> floor = 2
    expect(roundMexcQuantity("BTC_USDT", 50000, 0.00029)).toBe(2)
  })

  it("clamps a sub-minimum floored quantity up to minVol", () => {
    // 0.00004 / 0.0001 = 0.4 -> floor 0 -> clamped to minVol (1)
    expect(roundMexcQuantity("BTC_USDT", 50000, 0.00004)).toBe(1)
  })
})

describe("ensureSpecsLoaded refuses unverified specs", () => {
  beforeEach(() => {
    // Force the live fetch to fail so behavior is deterministic and offline:
    // known symbols fall back to KNOWN_SPECS, unknown symbols hit the generic
    // fallback (which must throw).
    vi.spyOn(globalThis, "fetch").mockRejectedValue(new Error("network disabled in test"))
  })
  afterEach(() => {
    vi.restoreAllMocks()
  })

  it("throws for a symbol with no verified specs (generic fallback)", async () => {
    await expect(ensureSpecsLoaded("ZZZFAKE_USDT", 1)).rejects.toThrow(
      /no verified contract specs/,
    )
  })

  it("resolves for a symbol present in KNOWN_SPECS", async () => {
    const spec = await ensureSpecsLoaded("BTC_USDT", 50000)
    expect(spec.contractSize).toBeGreaterThan(0)
  })
})
