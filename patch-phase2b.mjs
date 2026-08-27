import { readFileSync, writeFileSync } from "fs"

let src = readFileSync("lib/grid.ts", "utf8")
const log = []

function rep(oldStr, newStr, expected) {
  const count = src.split(oldStr).length - 1
  if (count === 0) {
    log.push(`MISS  (expected ${expected}): ${oldStr.slice(0, 60).replace(/\n/g, "\\n")}`)
    return
  }
  src = src.split(oldStr).join(newStr)
  log.push(`${count === expected ? "ok   " : "COUNT"} (${count}/${expected}): ${oldStr.slice(0, 60).replace(/\n/g, "\\n")}`)
}

// ── 1. Drop the static mexc/private import entirely ───────────────
rep(
  `import { placePostOnlyOrder, placeMarketOrder as makerMarketOrder, fetchOrderStatus, cancelOrders } from "./mexc/private"\n`,
  ``, 1
)

// ── 2. placeRoundedMakerOrder: add exchange param, route placement ─
rep(
  `async function placeRoundedMakerOrder(symbol: string, side: number, price: number, volume: number, leverage: number): Promise<any> {
  const rounded = roundForMexc(symbol, price, volume)
  return placePostOnlyOrder({`,
  `async function placeRoundedMakerOrder(symbol: string, side: number, price: number, volume: number, leverage: number, exchange: ExchangeClient): Promise<any> {
  const rounded = roundForMexc(symbol, price, volume)
  return exchange.placePostOnlyOrder({`, 1
)

// ── 3. cancelOtherPendingOrders: add exchange param ───────────────
rep(
  `async function cancelOtherPendingOrders(active: GridOrder[], keepId: number): Promise<void> {`,
  `async function cancelOtherPendingOrders(active: GridOrder[], keepId: number, exchange: ExchangeClient): Promise<void> {`, 1
)
rep(`      await cancelOrders(realIds)`, `      await exchange.cancelOrders(realIds)`, 1)

// ── 4. checkGridStopLoss: thread exchange into cancelOtherPendingOrders ─
rep(
  `await cancelOtherPendingOrders(active, o.id)`,
  `await cancelOtherPendingOrders(active, o.id, exchange ?? getExchangeClient(cfg.exchange as Exchange))`, 2
)

// ── 5. setupGrid: resolve client, route cancel + placement ────────
rep(
  `  } catch (err) {
    await log("error", \`Grid \${gc.symbol}: Failed to fetch MEXC specs: \${dbErr(err)}\`);
  }

    try {
      const existingOrders = await getActiveOrders(gc.symbol, gc.timeframe)`,
  `  } catch (err) {
    await log("error", \`Grid \${gc.symbol}: Failed to fetch MEXC specs: \${dbErr(err)}\`);
  }

  const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)

    try {
      const existingOrders = await getActiveOrders(gc.symbol, gc.timeframe)`, 1
)
rep(`          await cancelOrders(orderIds)`, `          await client.cancelOrders(orderIds)`, 1)
rep(
  `placeRoundedMakerOrder(ord.symbol, side, ord.price, ord.quantity, ord.leverage)`,
  `placeRoundedMakerOrder(ord.symbol, side, ord.price, ord.quantity, ord.leverage, client)`, 1
)

// ── 6. teardownGrid: guard + route cancel ─────────────────────────
rep(
  `  const makerIds = active.filter((o) => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
  if (makerIds.length > 0) {
    try {
      await cancelOrders(makerIds)`,
  `  const makerIds = active.filter((o) => o.mexcOrderId).map((o) => o.mexcOrderId!) as string[]
  if (makerIds.length > 0 && exchange) {
    try {
      await exchange.cancelOrders(makerIds)`, 1
)

// ── 7. settleMakerStopLoss: resolve client, route cancel + market close ─
rep(
  `  if (cfg.mode !== "paper") {
    if (order.mexcOrderId) {
      try {
        await cancelOrders([order.mexcOrderId])`,
  `  if (cfg.mode !== "paper") {
    const client = getExchangeClient(cfg.exchange as Exchange)
    if (order.mexcOrderId) {
      try {
        await client.cancelOrders([order.mexcOrderId])`, 1
)
rep(
  `await makerMarketOrder({ symbol: order.symbol, side: 4, volume: order.quantity, leverage: order.leverage })`,
  `await client.placeMarketOrder({ symbol: order.symbol, side: 4, volume: order.quantity, leverage: order.leverage })`, 1
)

// ── 8. settleMakerShortStopLoss: resolve client, route cancel + market close ─
rep(
  `if (cfg.mode !== "paper") {
  if (order.mexcOrderId) {
    try {
      await cancelOrders([order.mexcOrderId])`,
  `if (cfg.mode !== "paper") {
  const client = getExchangeClient(cfg.exchange as Exchange)
  if (order.mexcOrderId) {
    try {
      await client.cancelOrders([order.mexcOrderId])`, 1
)
rep(
  `await makerMarketOrder({ symbol: order.symbol, side: 2, volume: order.quantity, leverage: order.leverage })`,
  `await client.placeMarketOrder({ symbol: order.symbol, side: 2, volume: order.quantity, leverage: order.leverage })`, 1
)

// ── 9. runGridTickMaker: add exchange param, thread to short handler ─
rep(
  `async function runGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime): Promise<void> {
  if (gc.direction === "short" || (gc as any)._autoSide === "short") { return handleShortGridTickMaker(cfg, gc, snap, regime) }`,
  `async function runGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange: ExchangeClient): Promise<void> {
  if (gc.direction === "short" || (gc as any)._autoSide === "short") { return handleShortGridTickMaker(cfg, gc, snap, regime, exchange) }`, 1
)
rep(`await cancelOrders(liveIds)`, `await exchange.cancelOrders(liveIds)`, 2)
rep(`await fetchOrderStatus(o.mexcOrderId as string)`, `await exchange.fetchOrderStatus(o.mexcOrderId as string)`, 4)

// ── 10. handleShortGridTickMaker: add exchange param ──────────────
rep(
  `async function handleShortGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime): Promise<void> {`,
  `async function handleShortGridTickMaker(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, regime: Regime, exchange: ExchangeClient): Promise<void> {`, 1
)

// ── 11. runGridTick: pass resolved client into runGridTickMaker ───
rep(
  `  if (cfg.mode === "live" && isMakerSymbol(gc)) {
    return runGridTickMaker(cfg, gc, snap, regime)
  }`,
  `  if (cfg.mode === "live" && isMakerSymbol(gc)) {
    return runGridTickMaker(cfg, gc, snap, regime, exchange ?? getExchangeClient(cfg.exchange as Exchange))
  }`, 1
)

// ── 12. handleShortGridTick: resolve client, route status + placement ─
rep(
  `async function handleShortGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, exchange?: ExchangeClient): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  if (active.length === 0) {`,
  `async function handleShortGridTick(cfg: BotConfig, gc: GridConfig, snap: IndicatorSnapshot, exchange?: ExchangeClient): Promise<void> {
  let active = await getActiveOrders(gc.symbol, gc.timeframe)
  const client = exchange ?? getExchangeClient(cfg.exchange as Exchange)
  if (active.length === 0) {`, 1
)
rep(`await fetchOrderStatus(o.mexcOrderId)`, `await client.fetchOrderStatus(o.mexcOrderId)`, 2)

// ── 13. syncExchangeState: resolve client, route status ───────────
rep(
  `    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    console.log(\`[Reconcile] Syncing state for \${configs.length} enabled pairs...\`)`,
  `    const configs = await db.select().from(gridConfigs).where(eq(gridConfigs.enabled, true))
    const cfgRows = await db.select().from(botConfig).limit(1)
    const client = getExchangeClient((cfgRows[0]?.exchange as Exchange) ?? "mexc")
    console.log(\`[Reconcile] Syncing state for \${configs.length} enabled pairs...\`)`, 1
)
rep(`await fetchOrderStatus(dbOrder.mexcOrderId as string)`, `await client.fetchOrderStatus(dbOrder.mexcOrderId as string)`, 1)

// ── 14. placeRoundedMakerOrder call sites (arg-unique) ────────────
rep(`placeRoundedMakerOrder(o.symbol, 3, entryPrice, o.quantity, o.leverage)`, `placeRoundedMakerOrder(o.symbol, 3, entryPrice, o.quantity, o.leverage, exchange)`, 2)
rep(`placeRoundedMakerOrder(o.symbol, 4, sellPrice, o.quantity, o.leverage)`, `placeRoundedMakerOrder(o.symbol, 4, sellPrice, o.quantity, o.leverage, exchange)`, 1)
rep(`placeRoundedMakerOrder(o.symbol, 1, o.buyPrice, o.quantity, o.leverage)`, `placeRoundedMakerOrder(o.symbol, 1, o.buyPrice, o.quantity, o.leverage, exchange)`, 1)
rep(`placeRoundedMakerOrder(o.symbol, 3, newSellPrice, o.quantity, o.leverage)`, `placeRoundedMakerOrder(o.symbol, 3, newSellPrice, o.quantity, o.leverage, client)`, 2)

// ── 15. the three identical closePrice buy-to-close calls (indentation) ─
let closeCount = 0
src = src.replace(
  /^(\s*)const res: any = await placeRoundedMakerOrder\(o\.symbol, 2, closePrice, o\.quantity, o\.leverage\)/gm,
  (m, indent) => {
    closeCount++
    const suffix = indent.length === 12 ? ", client" : ", exchange"
    return `${indent}const res: any = await placeRoundedMakerOrder(o.symbol, 2, closePrice, o.quantity, o.leverage${suffix})`
  }
)
log.push(`${closeCount === 3 ? "ok   " : "COUNT"} (${closeCount}/3): closePrice buy-to-close (indent-disambiguated)`)

writeFileSync("lib/grid.ts", src)
console.log(log.join("\n"))
console.log("\ndone")
