import { computeSnapshot } from "./lib/indicators"
import { detectRegime } from "./lib/strategy"

const TAKER_FEE = 0.0002
const CFG = { emaFast:9,emaSlow:21,rsiPeriod:14,rsiOverbought:70,rsiOversold:30,atrPeriod:14,strategyMode:"auto" as const,adxTrendThreshold:25,adxRangeThreshold:20,bbPeriod:20,bbStd:2,slAtrMult:1.5,tpAtrMult:2.5,trailAtrMult:1.2,momentumThreshold:0.6,leverage:5,positionSizeUsdt:500,allowLong:true,allowShort:true }

interface Candle { time:number;open:number;high:number;low:number;close:number;volume:number }
interface Pos { side:"long"|"short";entryPrice:number;sizeUsdt:number;quantity:number;leverage:number;stopLoss:number;takeProfit:number;openedAt:number }
interface Trade { side:string;entryPrice:number;exitPrice:number;pnl:number;exitReason:string;openedAt:number }

function rsi(c:number[],p:number):number[]{const o:number[]=new Array(c.length).fill(50);let ag=0,al=0
  for(let i=1;i<c.length;i++){const ch=c[i]-c[i-1],g=Math.max(ch,0),l=Math.max(-ch,0)
    if(i<=p){ag+=g/p;al+=l/p;o[i]=50}else{ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;o[i]=al===0?100:100-100/(1+ag/al)}}return o}

async function fetchAll(sym:string,tf:string,days:number):Promise<Candle[]>{
  const isec={Min1:60,Min5:300,Min15:900,Min30:1800,Min60:3600,Hour4:14400}[tf]??300
  const es=Math.floor(Date.now()/1000),ss=es-days*86400
  const all:Candle[]=[];let fe=es
  while(true){const fs=Math.max(ss,fe-2000*isec)
    const u=`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${tf}&start=${fs}&end=${fe}`
    try{const r=await fetch(u);const j=await r.json() as any
      if(!j.success||!j.data?.time?.length)break
      const{time,open,high,low,close,vol}=j.data
      for(let i=0;i<time.length;i++){if(time[i]>=ss&&time[i]<=es)all.push({time:time[i],open:open[i],high:high[i],low:low[i],close:close[i],volume:vol[i]??0})}
      if(time[0]<=ss||time.length<100)break;fe=time[0]-isec
    }catch{break}}
  all.sort((a,b)=>a.time-b.time)
  return all.filter((c,i,a)=>i===0||c.time!==a[i-1].time)
}

async function test(sym:string,tf:string,strat:string,days:number=30){
  const candles=await fetchAll(sym,tf,days)
  if(candles.length<200){console.log(`${sym.padEnd(12)} ${tf.padEnd(6)} ${strat.padEnd(12)} | only ${candles.length} candles`);return}
  const closes=candles.map(c=>c.close),rsiArr=rsi(closes,14)
  let pos:Pos|null=null;const trades:Trade[]=[];let equity=10000,lastTime=0,lastDir:string|null=null

  // Grid state
  let gBuys:{price:number,qty:number}[]=[],gSells:{price:number,qty:number,buyPrice:number}[]=[]
  const GS=0.3,GL=5

  for(let i=200;i<candles.length;i++){
    const window=candles.slice(0,i+1),snap=computeSnapshot(window,CFG)
    const price=snap.price

    // GRID
    if(strat==="grid"){
      if(gBuys.length===0&&gSells.length===0){for(let l=1;l<=GL;l++){const bp=price*(1-GS/100*l);gBuys.push({price:bp,qty:(500*5)/bp})}}
      for(const b of [...gBuys]){if(price<=b.price){gBuys=gBuys.filter(x=>x!==b);gSells.push({price:b.price*(1+GS/100),qty:b.qty,buyPrice:b.price})}}
      for(const s of [...gSells]){if(price>=s.price){gSells=gSells.filter(x=>x!==s)
        const gp=(s.price-s.buyPrice)*s.qty,f=s.buyPrice*s.qty*TAKER_FEE+s.price*s.qty*TAKER_FEE
        trades.push({side:"long",entryPrice:s.buyPrice,exitPrice:s.price,pnl:gp-f,exitReason:"grid",openedAt:candles[i].time});equity+=gp-f
        gBuys.push({price:s.buyPrice,qty:s.qty})}}
      continue
    }

    // EXIT
    if(pos){const d=pos.side==="long"?1:-1;let ex=false,reason=""
      if(strat==="meanrev"){const r=rsiArr[i];ex=(pos.side==="long"&&r>=62)||(pos.side==="short"&&r<=38);if(ex)reason="rsi"}
      if(pos.side==="long"?price<=pos.stopLoss:price>=pos.stopLoss){ex=true;reason="sl"}
      if(pos.side==="long"?price>=pos.takeProfit:price<=pos.takeProfit){ex=true;reason="tp"}
      if(ex){const gp=(price-pos.entryPrice)*d*pos.quantity,f=pos.entryPrice*pos.quantity*TAKER_FEE+price*pos.quantity*TAKER_FEE
        trades.push({side:pos.side,entryPrice:pos.entryPrice,exitPrice:price,pnl:gp-f,exitReason:reason,openedAt:pos.openedAt});equity+=gp-f;pos=null;lastDir=null}}

    // ENTRY
    if(!pos){let dir:"long"|"short"|null=null
      if(strat==="meanrev"){const r=rsiArr[i];if(r<=20&&CFG.allowLong)dir="long";else if(r>=80&&CFG.allowShort)dir="short"}
      else if(strat==="trend-range"){const regime=detectRegime(snap,CFG)
        if(regime==="trend"){const bc=snap.prevEmaFast<=snap.prevEmaSlow&&snap.emaFast>snap.emaSlow,bs=snap.prevEmaFast>=snap.prevEmaSlow&&snap.emaFast<snap.emaSlow,ab=snap.emaFast>snap.emaSlow&&snap.prevEmaFast>snap.prevEmaSlow,as=snap.emaFast<snap.emaSlow&&snap.prevEmaFast<snap.prevEmaSlow
          if((bc||ab)&&snap.rsi<CFG.rsiOverbought&&CFG.allowLong)dir="long";else if((bs||as)&&snap.rsi>CFG.rsiOversold&&CFG.allowShort)dir="short"}
        else if(regime==="range"){if(price<=snap.bbLower&&snap.rsi<=CFG.rsiOversold&&CFG.allowLong)dir="long";else if(price>=snap.bbUpper&&snap.rsi>=CFG.rsiOverbought&&CFG.allowShort)dir="short"}}
      if(dir){const tooSoon=dir===lastDir&&candles[i].time-lastTime<(tf==="Min60"?3600:900)
        if(!tooSoon){const q=(CFG.positionSizeUsdt*CFG.leverage)/price,atrVal=snap.atr
          const sl=dir==="long"?price-atrVal*1.0:price+atrVal*1.0,tp=dir==="long"?price+atrVal*3.0:price-atrVal*3.0
          pos={side:dir,entryPrice:price,sizeUsdt:CFG.positionSizeUsdt,quantity:q,leverage:CFG.leverage,stopLoss:sl,takeProfit:tp,openedAt:candles[i].time}
          lastTime=candles[i].time;lastDir=dir}}}
  }

  if(pos){const lp=candles[candles.length-1].close;const d=pos.side==="long"?1:-1
    const gp=(lp-pos.entryPrice)*d*pos.quantity,f=pos.entryPrice*pos.quantity*TAKER_FEE+lp*pos.quantity*TAKER_FEE
    trades.push({side:pos.side,entryPrice:pos.entryPrice,exitPrice:lp,pnl:gp-f,exitReason:"eob",openedAt:pos.openedAt});equity+=gp-f}
  if(strat==="grid"){const lp=candles[candles.length-1].close;for(const s of gSells){const gp=(lp-s.buyPrice)*s.qty,f=s.buyPrice*s.qty*TAKER_FEE+lp*s.qty*TAKER_FEE;trades.push({side:"long",entryPrice:s.buyPrice,exitPrice:lp,pnl:gp-f,exitReason:"eob",openedAt:candles[candles.length-1].time});equity+=gp-f}}

  const wins=trades.filter(t=>t.pnl>0),losses=trades.filter(t=>t.pnl<=0)
  const tp=trades.reduce((s,t)=>s+t.pnl,0),gl=losses.reduce((s,t)=>s+Math.abs(t.pnl),0)
  const pf=gl===0?Infinity:wins.reduce((s,t)=>s+t.pnl,0)/gl,wr=trades.length>0?wins.length/trades.length:0
  console.log(`${sym.padEnd(12)} ${tf.padEnd(6)} ${strat.padEnd(12)} | ${trades.length.toString().padStart(3)} trades  WR ${(wr*100).toFixed(0).padStart(2)}%  PF ${pf===Infinity?"∞":pf.toFixed(2)}  PnL ${tp>=0?"+":""}${tp.toFixed(2).padStart(7)}  Equity ${equity.toFixed(2)}`)
}

async function runAll(){
  const tests=[["BTC_USDT","Min5","meanrev"],["BTC_USDT","Min15","meanrev"],["BTC_USDT","Min30","meanrev"],["BTC_USDT","Min60","meanrev"],["SOL_USDT","Min15","meanrev"],["DOGE_USDT","Min15","meanrev"],["PEPE_USDT","Min15","meanrev"],["BTC_USDT","Min15","grid"],["ETH_USDT","Min15","grid"],["SOL_USDT","Min15","grid"],["BTC_USDT","Min60","trend-range"],["ETH_USDT","Min60","trend-range"]]
  console.log("Symbol        TF     Strategy      Trades  WR   PF     PnL       Equity")
  console.log("─".repeat(78))
  for(const[s,tf,st]of tests){try{await test(s,tf,st)}catch(e){console.log(`${s.padEnd(12)} ${tf.padEnd(6)} ${st.padEnd(12)} | error: ${e}`)}}
}
runAll().catch(console.error)
