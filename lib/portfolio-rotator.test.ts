import { describe, expect, it } from "vitest"
import { planRotation, isDeadGrid, isRotationHeld } from "./portfolio-rotator"

const cfg = (id: number, symbol: string, metadata?: any) => ({ id, symbol, metadata })
const audit = (id: number, symbol: string, ageHours: number, pnl: number, metadata?: any) => ({
  config: cfg(id, symbol, metadata),
  ageHours,
  pnl,
})

describe("isDeadGrid", () => {
  it("kills old grids at zero or negative PnL", () => {
    expect(isDeadGrid(6, 0)).toBe(true)
    expect(isDeadGrid(100, -50)).toBe(true)
  })

  it("spares young grids and winners", () => {
    expect(isDeadGrid(5.9, -100)).toBe(false)
    expect(isDeadGrid(100, 0.01)).toBe(false)
  })
})

describe("isRotationHeld", () => {
  it("holds only on an explicit metadata flag", () => {
    expect(isRotationHeld(cfg(1, "NEAR_USDT", { rotationHold: true }))).toBe(true)
    expect(isRotationHeld(cfg(1, "NEAR_USDT", { rotationHold: false }))).toBe(false)
    expect(isRotationHeld(cfg(1, "NEAR_USDT", {}))).toBe(false)
    expect(isRotationHeld(cfg(1, "NEAR_USDT"))).toBe(false)
    expect(isRotationHeld(cfg(1, "NEAR_USDT", null))).toBe(false)
  })
})

describe("planRotation", () => {
  it("prunes dead grids even with zero candidates (the coupling defect)", () => {
    const plan = planRotation(
      [audit(1, "1000PEPE_USDT", 100, -50), audit(2, "ENA_USDT", 100, 37)],
      [],
    )
    expect(plan.pruneIds).toEqual([1])
    expect(plan.replacements).toEqual([])
  })

  it("never prunes or replaces held grids", () => {
    const plan = planRotation(
      [audit(1, "NEAR_USDT", 100, -14, { rotationHold: true })],
      [{ symbol: "SUI_USDT" }],
    )
    expect(plan.pruneIds).toEqual([])
    expect(plan.replacements).toEqual([])
  })

  it("prunes uncapped but replaces only up to the cap, skipping deployed symbols", () => {
    const audits = [
      audit(1, "A", 10, -1),
      audit(2, "B", 10, -1),
      audit(3, "C", 10, -1),
      audit(4, "D", 10, -1),
    ]
    const plan = planRotation(
      audits,
      [{ symbol: "X" }, { symbol: "ENA_USDT" }, { symbol: "Y" }],
      { existingSymbols: new Set(["ENA_USDT"]), maxReplacements: 2 },
    )
    expect(plan.pruneIds).toEqual([1, 2, 3, 4])
    expect(plan.replacements.map(r => r.candidate.symbol)).toEqual(["X", "Y"])
    expect(plan.replacements[0].deadSymbol).toBe("A")
  })

  it("still prunes when the budget cap blocks every replacement", () => {
    const plan = planRotation(
      [audit(1, "A", 10, -1)],
      [{ symbol: "X", budgetPct: 50 }],
      { deployedPct: 60 },
    )
    expect(plan.pruneIds).toEqual([1])
    expect(plan.replacements).toEqual([])
  })

  it("ignores null candidates and spares the young", () => {
    const plan = planRotation([audit(1, "A", 1, -5)], [null as any])
    expect(plan.pruneIds).toEqual([])
    expect(plan.replacements).toEqual([])
  })
})
