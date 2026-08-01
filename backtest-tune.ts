// Tuning mean-reversion: RSI thresholds, exit levels, profit targets
import { computeSnapshot } from "./lib/indicators"
import { evaluateExit, computeInitialStops } from "./lib/exits"

const args = process.argv.slice(2)
const symbol = "BTC_USDT", timeframe = "Min5", daysBack = 30
const rsiBuy = parseInt(args[0] ?? "25")
const rsiSell = parseInt(args[1] ?? "75")
const exitLevel = parseInt(args[2] ?? "50")
const tpAtr = parseFloat(args[3] ?? "1.5")

const CFG = {
  symbol, timeframe,
  emaFast: 9, emaSlow: 21, rsiPeriod: 14, rsiOverbought: 70, rsiOversold: 30,
  atrPeriod: 14, strategyMode: "auto" as const,
  adxTrendThreshold: 25, adxRangeThreshold: 20, bbPeriod: 20, bbStd: 2,
  slAtrMult: 1.5, tpAtrMult: 2.5, trailAtrMult: 1.2, momentumThreshold: 0.6,
  leverage: 5, positionSizeUsdt: 500, allowLong: true, allowShort: true,
}
const TAKER_FEE = 0.0002

interface Candle { time: number; open: number; high: number; low: number; close: number; volume: number }
interface Pos { side: "long" | "short"; entryPrice: number; sizeUsdt: number; quantity: number; leverage: number; stopLoss: number; takeProfit: number; openedAt: number }
interface Trade { side: string; entryPrice: number; exitPrice: number; pnl: number; pnlPct: number; exitReason: string; openedAt: number }

function rsi(c: number[], p: number): number[] {
  const out: number[] = new Array(c.length).fill(50)
  let ag=0,al=0
  for(let i=1;i<c.length;i++){const ch=c[i]-c[i-1],g=Math.max(ch,0),l=Math.max(-ch,0)
    if(i<=p){ag+=g/p;al+=l/p;out[i]=50}else{ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;out[i]=al===0?100:100-100/(1+ag/al)}}
  return out
}

async function fetchAll(): Promise<Candle[]> {
  const endSec=Math.floor(Date.now()/1000),startSec=endSec-daysBack*86400
  const all:Candle[]=[];let fe=endSec
  while(true){const fs=Math.max(startSec,fe-2000*300)
    const u=`https://contract.mexc.com/api/v1/contract/kline/${symbol}?interval=${timeframe}&start=${fs}&end=${fe}`
    const r=await fetch(u);const j=await r.json() as any
    if(!j.success||!j.data?.time?.length)break
    const{time,open,high,low,close,vol}=j.data
    for(let i=0;i<time.length;i++){if(time[i]>=startSec&&time[i]<=endSec)all.push({time:time[i],open:open[i],high:high[i],low:low[i],close:close[i],volume:vol[i]??0})}
    if(time[0]<=startSec||time.length<100)break;fe=time[0]-300}
  all.sort((a,b)=>a.time-b.time)
  return all.filter((c,i,a)=>i===0||c.time!==a[i-1].time)
}

async function main(){
  const candles=await fetchAll()
  const closes=candles.map(c=>c.close),rsiArr=rsi(closes,14)
  let pos:Pos|null=null;const trades:Trade[]=[];let equity=10000
  let lastEntryTime=0,lastDir:string|null=null

  for(let i=200;i<candles.length;i++){
    const window=candles.slice(0,i+1),snap=computeSnapshot(window,CFG)

    if(pos){
      const rsiNow=rsiArr[i]
      const dir=pos.side==="long"?1:-1
      const exitRsi=(pos.side==="long"&&rsiNow>=exitLevel)||(pos.side==="short"&&rsiNow<=exitLevel)
      const hitSl=pos.side==="long"?snap.price<=pos.stopLoss:snap.price>=pos.stopLoss
      const hitTp=pos.side==="long"?snap.price>=pos.takeProfit:snap.price<=pos.takeProfit
      const exitNow=exitRsi||hitSl||hitTp
      if(exitNow){
        const grossPnl=(snap.price-pos.entryPrice)*dir*pos.quantity
        const fees=pos.entryPrice*pos.quantity*TAKER_FEE+snap.price*pos.quantity*TAKER_FEE
        const reason=hitSl?"sl":hitTp?"tp":"rsi-neutral"
        trades.push({side:pos.side,entryPrice:pos.entryPrice,exitPrice:snap.price,pnl:grossPnl-fees,pnlPct:((grossPnl-fees)/pos.sizeUsdt)*100,exitReason:reason,openedAt:pos.openedAt})
        equity+=grossPnl-fees;pos=null;lastDir=null
      }
    }

    if(!pos){
      const rsiNow=rsiArr[i]
      let direction:"long"|"short"|null=null
      if(rsiNow<=rsiBuy&&CFG.allowLong)direction="long"
      else if(rsiNow>=rsiSell&&CFG.allowShort)direction="short"

      if(direction){
        const tooSoon=direction===lastDir&&candles[i].time-lastEntryTime<900
        if(tooSoon)continue
        const quantity=(CFG.positionSizeUsdt*CFG.leverage)/snap.price
        const sl=direction==="long"?snap.price-snap.atr*1.0:snap.price+snap.atr*1.0
        const tp=direction==="long"?snap.price+snap.atr*tpAtr:snap.price-snap.atr*tpAtr
        pos={side:direction,entryPrice:snap.price,sizeUsdt:CFG.positionSizeUsdt,quantity,leverage:CFG.leverage,stopLoss:sl,takeProfit:tp,openedAt:candles[i].time}
        lastEntryTime=candles[i].time;lastDir=direction
      }
    }
  }

  if(pos){const lp=candles[candles.length-1].close;const d=pos.side==="long"?1:-1
    const gp=(lp-pos.entryPrice)*d*pos.quantity
    const f=pos.entryPrice*pos.quantity*TAKER_FEE+lp*pos.quantity*TAKER_FEE
    trades.push({side:pos.side,entryPrice:pos.entryPrice,exitPrice:lp,pnl:gp-f,pnlPct:((gp-f)/pos.sizeUsdt)*100,exitReason:"eob",openedAt:pos.openedAt})
    equity+=gp-f}

  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<=0)
  const totalPnl=trades.reduce((s,t)=>s+t.pnl,0)
  const grossLoss=losses.reduce((s,t)=>s+Math.abs(t.pnl),0)
  const pf=grossLoss===0?Infinity:wins.reduce((s,t)=>s+t.pnl,0)/grossLoss
  const wr=trades.length>0?wins.length/trades.length:0

  const byExit:Record<string,{count:number,pnl:number}>={}
  for(const t of trades){const k=t.exitReason;if(!byExit[k])byExit[k]={count:0,pnl:0};byExit[k].count++;byExit[k].pnl+=t.pnl}

  console.log(`RSI buy<${rsiBuy} sell>${rsiSell} exit=${exitLevel} tpATR=${tpAtr} | ${trades.length} trades WR ${(wr*100).toFixed(0)}% PF ${pf===Infinity?"∞":pf.toFixed(2)} PnL ${totalPnl>=0?"+":""}${totalPnl.toFixed(2)} Equity ${equity.toFixed(2)}`)
  for(const[k,v]of Object.entries(byExit).sort()){
    console.log(`  ${k.padEnd(12)} ${v.count.toString().padStart(3)} trades  PnL ${v.pnl.toFixed(2)}`)
  }
}

main().catch(console.error)
