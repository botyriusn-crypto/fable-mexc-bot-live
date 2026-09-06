import { describe, it, expect, vi } from "vitest"
import { confirmFill, type OrderStatus } from "./exchange"

// Helpers to build canonical OrderStatus objects.
const filled = (price: number, vol: number): OrderStatus => ({
  state: 3,
  dealAvgPrice: price,
  dealVol: vol,
  isError: false,
})
const partial = (price: number, vol: number): OrderStatus => ({
  state: 2,
  dealAvgPrice: price,
  dealVol: vol,
  isError: false,
})
const unfilled = (): OrderStatus => ({ state: 1, dealAvgPrice: 0, dealVol: 0, isError: false })
const cancelled = (): OrderStatus => ({ state: 4, dealAvgPrice: 0, dealVol: 0, isError: false })
const errored = (): OrderStatus => ({ state: -1, dealAvgPrice: 0, dealVol: 0, isError: true })

// Every test uses a tiny delay so the polling loop resolves fast.
const fast = { attempts: 5, delayMs: 1 }
const idOf = (raw: any) => String(raw?.id ?? "")

describe("confirmFill", () => {
  it("confirms a fully-filled order on the first poll", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(filled(100.5, 2))
    const res = await confirmFill({
      placeRaw: { id: "abc" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(true)
    expect(res.orderId).toBe("abc")
    expect(res.avgPrice).toBe(100.5)
    expect(res.filledVolume).toBe(2)
    expect(res.state).toBe(3)
    // Filled state should short-circuit — only one status call.
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it("confirms a partial fill (price known) without requiring full fill", async () => {
    // Always partially filled — never reaches state 3.
    const fetchStatus = vi.fn().mockResolvedValue(partial(50, 1))
    const res = await confirmFill({
      placeRaw: { id: "p1" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(true)
    expect(res.avgPrice).toBe(50)
    expect(res.filledVolume).toBe(1)
    // Keeps polling for the rest — exhausts all attempts.
    expect(fetchStatus).toHaveBeenCalledTimes(fast.attempts)
  })

  it("returns unconfirmed when the order never fills", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(unfilled())
    const res = await confirmFill({
      placeRaw: { id: "n1" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(false)
    expect(res.avgPrice).toBe(0)
    expect(res.filledVolume).toBe(0)
    expect(fetchStatus).toHaveBeenCalledTimes(fast.attempts)
  })

  it("returns unconfirmed and stops early when the order is cancelled with no fill", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(cancelled())
    const res = await confirmFill({
      placeRaw: { id: "c1" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(false)
    expect(res.state).toBe(4)
    // Cancelled/no-fill short-circuits after the first poll.
    expect(fetchStatus).toHaveBeenCalledTimes(1)
  })

  it("returns unconfirmed without polling when no order id can be extracted", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(filled(100, 1))
    const res = await confirmFill({
      placeRaw: { somethingElse: true },
      extractOrderId: idOf, // yields "" for this payload
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(false)
    expect(res.orderId).toBe("")
    expect(fetchStatus).not.toHaveBeenCalled()
  })

  it("tolerates status errors and keeps polling", async () => {
    // First two polls throw, third returns a real fill.
    const fetchStatus = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockRejectedValueOnce(new Error("network"))
      .mockResolvedValue(filled(42, 3))
    const res = await confirmFill({
      placeRaw: { id: "e1" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(true)
    expect(res.avgPrice).toBe(42)
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })

  it("treats an isError status as no-fill and stays unconfirmed", async () => {
    const fetchStatus = vi.fn().mockResolvedValue(errored())
    const res = await confirmFill({
      placeRaw: { id: "x1" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(false)
    expect(res.avgPrice).toBe(0)
  })

  it("confirms once a fill appears on a later poll", async () => {
    const fetchStatus = vi
      .fn()
      .mockResolvedValueOnce(unfilled())
      .mockResolvedValueOnce(unfilled())
      .mockResolvedValue(filled(7.25, 10))
    const res = await confirmFill({
      placeRaw: { id: "l1" },
      extractOrderId: idOf,
      fetchStatus,
      ...fast,
    })
    expect(res.confirmed).toBe(true)
    expect(res.avgPrice).toBe(7.25)
    expect(res.filledVolume).toBe(10)
    expect(fetchStatus).toHaveBeenCalledTimes(3)
  })
})
