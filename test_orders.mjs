import { fetchOpenOrders, fetchOrderStatus } from "./lib/mexc/private.ts"
const symbol = "BANK_USDT"
console.log("=== fetchOpenOrders(" + symbol + ") ===")
const open = await fetchOpenOrders(symbol)
console.log("count:", open.length)
console.log(JSON.stringify(open, null, 2))
if (open.length > 0 && open[0].orderId) {
  console.log("=== fetchOrderStatus ===")
  console.log(JSON.stringify(await fetchOrderStatus(String(open[0].orderId)), null, 2))
}
process.exit(0)
