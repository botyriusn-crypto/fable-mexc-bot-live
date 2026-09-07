import { describe, it, expect } from "vitest"
import { detectFundingCarry, type FundingCarryConfig } from "./funding-carry"

const base: FundingCarryConfig = {
  enabled: true,
  fundingThreshold: 0.0002,
  momentumLookbackSec: 259200,
  horizonSec: 28800,
  sizeUsdt: 50,
  leverage: 3,
  tpBps: 100,
  slBps: 40,
}

describe("detectFundingCarry momentum (default)", () => {
  it("rides positive crowding long", () => {
    const s = detectFundingCarry(0.0005, 0.0003, base)
    expect(s?.direction).toBe("long")
  })

  it("rides negative crowding short", () => {
    const s = detectFundingCarry(-0.0005, -0.0003, base)
    expect(s?.direction).toBe("short")
  })

  it("sits out unwinding funding", () => {
    expect(detectFundingCarry(0.0005, 0.0008, base)).toBeNull()
    expect(detectFundingCarry(-0.0002, -0.0005, base)).toBeNull()
  })

  it("sits out sub-threshold funding", () => {
    expect(detectFundingCarry(0.0001, 0.00005, base)).toBeNull()
  })

  it("legacy fade mode still fades the rollover", () => {
    const fade = { ...base, followTrend: false }
    const s = detectFundingCarry(0.0005, 0.0008, fade)
    expect(s?.direction).toBe("short")
  })
})
