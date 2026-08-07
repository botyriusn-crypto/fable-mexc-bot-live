import { NextResponse } from "next/server"
import { ema, atr, adx } from "@/lib/indicators"
import type { Candle } from "@/lib/mexc/public"

export const dynamic = "force-dynamic"
export const maxDuration = 60

export async function GET() {
  try {
    // 1. Fetch top MEXC pairs by volume
    const tickerRes = await fetch("https://contract.mexc.com/api/v1/contract/ticker")
    const tickerJson = await tickerRes.json() as any
    if (!tickerJson.success) throw new Error("Failed to fetch MEXC tickers")
    
    const candidates = (tickerJson.data as any[])
      .filter(t => t.symbol.endsWith("_USDT") && !t.symbol.includes("STOCK"))
      .filter(t => t.amount24 > 50000000) // > $50M volume
      .sort((a, b) => b.amount24 - a.amount24)
      .slice(0, 15) // Deep scan top 15

    const marketData: any[] = []

    // 2. Compute Math for AI
    for (const t of candidates) {
      try {
        const end = Math.floor(Date.now() / 1000)
        const start = end - (24 * 3600)
        const klineRes = await fetch(`https://contract.mexc.com/api/v1/contract/kline/${t.symbol}?interval=Min60&start=${start}&end=${end}`)
        const klineJson = await klineRes.json() as any
        if (!klineJson.success || !klineJson.data?.time?.length) continue
        
        const { time, open, high, low, close, vol } = klineJson.data
        const candles: Candle[] = []
        for (let i = 0; i < time.length; i++) {
          candles.push({ time: time[i], open: open[i], high: high[i], low: low[i], close: close[i], volume: vol[i] ?? 0 })
        }
        if (candles.length < 20) continue
        
        const closes = candles.map(c => c.close)
        const lastClose = closes[closes.length - 1]
        const atrArr = atr(candles, 14)
        const adxArr = adx(candles, 14)
        
        marketData.push({
          symbol: t.symbol,
          volumeUsdt: Math.round(t.amount24),
          atrPct: parseFloat(((atrArr[atrArr.length - 1] / lastClose) * 100).toFixed(2)),
          adx: parseFloat(adxArr[adxArr.length - 1].toFixed(1))
        })
      } catch (err) { continue }
    }

    // 3. Call LLM (Deepseek/OpenAI) to synthesize recommendations
    const systemPrompt = `You are an elite quantitative grid trading advisor. 
Analyze the provided market data array and select the top 3 assets best suited for a geometric grid bot RIGHT NOW.
Rules:
1. ADX must be between 15 and 30 (ranging/choppy market).
2. ATR% must be above 1.2% (to beat trading fees).
3. Based on volatility, recommend levels (5-8), atrMult (1.0-2.0), leverage (3-5), and budgetPct (10-20).
You MUST respond with ONLY a valid JSON array. No markdown, no explanation.
Schema: [{"symbol": "", "reason": "", "levels": 0, "atrMult": 0.0, "leverage": 0, "budgetPct": 0}]`

    const llmRes = await fetch("https://api.deepseek.com/chat/completions", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "Authorization": `Bearer ${process.env.DEEPSEEK_API_KEY || process.env.OPENAI_API_KEY}`
      },
      body: JSON.stringify({
        model: "deepseek-chat",
        messages: [
          { role: "system", content: systemPrompt },
          { role: "user", content: JSON.stringify(marketData) }
        ],
        response_format: { type: "json_object" } // Forces JSON
      })
    })

    const llmJson = await llmRes.json()
    let content = llmJson.choices?.[0]?.message?.content || "[]"
    
    // Deepseek JSON mode sometimes wraps in an object, extract the array
    if (content.startsWith("{")) {
      try {
        const parsedObj = JSON.parse(content)
        content = JSON.stringify(Object.values(parsedObj)[0])
      } catch {}
    }

    const recommendations = JSON.parse(content)
    return NextResponse.json({ success: true, recommendations })

  } catch (err: any) {
    console.error("AI Advisor Error:", err)
    return NextResponse.json({ success: false, error: err?.message || "AI scan failed" }, { status: 500 })
  }
}
