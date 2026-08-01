import { computeSnapshot } from "./lib/indicators"
const TAKER_FEE=0.0002
const CFG={emaFast:9,emaSlow:21,rsiPeriod:14,rsiOverbought:70,rsiOversold:30,atrPeriod:14,strategyMode:"auto" as const,adxTrendThreshold:25,adxRangeThreshold:20,bbPeriod:20,bbStd:2,slAtrMult:1.5,tpAtrMult:2.5,trailAtrMult:1.2,momentumThreshold:0.6,leverage:5,positionSizeUsdt:500,allowLong:true,allowShort:true}
interface Candle{time:number;open:number;high:number;low:number;close:number;volume:number}
interface Trade{side:string;entryPrice:number;exitPrice:number;pnl:number;exitReason:string;openedAt:number}

function rsi(c:number[],p:number):number[]{const o:number[]=new Array(c.length).fill(50);let ag=0,al=0
  for(let i=1;i<c.length;i++){const ch=c[i]-c[i-1],g=Math.max(ch,0),l=Math.max(-ch,0)
    if(i<=p){ag+=g/p;al+=l/p;o[i]=50}else{ag=(ag*(p-1)+g)/p;al=(al*(p-1)+l)/p;o[i]=al===0?100:100-100/(1+ag/al)}}return o}

async function fetchAll(sym:string,tf:string,days:number):Promise<Candle[]>{
  const isec={Min15:900}[tf]??900;const es=Math.floor(Date.now()/1000),ss=es-days*86400
  const all:Candle[]=[];let fe=es
  while(true){const fs=Math.max(ss,fe-2000*isec)
    const u=`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${tf}&start=${fs}&end=${fe}`
    try{const r=await fetch(u);const j=await r.json() as any
      if(!j.success||!j.data?.time?.length)break
      const{time,open,high,low,close,vol}=j.data
      for(let i=0;i<time.length;i++){if(time[i]>=ss&&time[i]<=es)all.push({time:time[i],open:open[i],high:high[i],low:low[i],close:close[i],volume:vol[i]??0})}
      if(time[0]<=ss||time.length<100)break;fe=time[0]-isec}catch{break}}
  all.sort((a,b)=>a.time-b.time)
  return all.filter((c,i,a)=>i===0||c.time!==a[i-1].time)
}

async function testGrid(sym:string,tf:string,days:number=30){
  const candles=await fetchAll(sym,tf,days)
  if(candles.length<200){console.log(`${sym.padEnd(12)} | only ${candles.length} candles`);return}
  const trades:Trade[]=[];let equity=10000
  let gBuys:{price:number,qty:number}[]=[],gSells:{price:number,qty:number,buyPrice:number}[]=[]
  const GS=0.3,GL=5

  for(let i=200;i<candles.length;i++){
    const price=candles[i].close
    if(gBuys.length===0&&gSells.length===0){for(let l=1;l<=GL;l++){const bp=price*(1-GS/100*l);gBuys.push({price:bp,qty:(500*5)/bp})}}
    for(const b of [...gBuys]){if(price<=b.price){gBuys=gBuys.filter(x=>x!==b);gSells.push({price:b.price*(1+GS/100),qty:b.qty,buyPrice:b.price})}}
    for(const s of [...gSells]){if(price>=s.price){gSells=gSells.filter(x=>x!==s)
      const gp=(s.price-s.buyPrice)*s.qty,f=s.buyPrice*s.qty*TAKER_FEE+s.price*s.qty*TAKER_FEE
      trades.push({side:"long",entryPrice:s.buyPrice,exitPrice:s.price,pnl:gp-f,exitReason:"grid",openedAt:candles[i].time});equity+=gp-f
      gBuys.push({price:s.buyPrice,qty:s.qty})}}
  }
  const lp=candles[candles.length-1].close;for(const s of gSells){const gp=(lp-s.buyPrice)*s.qty,f=s.buyPrice*s.qty*TAKER_FEE+lp*s.qty*TAKER_FEE;trades.push({side:"long",entryPrice:s.buyPrice,exitPrice:lp,pnl:gp-f,exitReason:"eob",openedAt:candles[candles.length-1].time});equity+=gp-f}
  const pnl=trades.reduce((s,t)=>s+t.pnl,0)
  console.log(`${sym.padEnd(12)} GRID    | ${trades.length.toString().padStart(3)} trades  PnL ${pnl>=0?"+":""}${pnl.toFixed(2).padStart(7)}  Equity ${equity.toFixed(2)}  Return ${((equity-10000)/100).toFixed(1)}%`)
}

async function testMeanRev(sym:string,tf:string,days:number=30){
  const candles=await fetchAll(sym,tf,days)
  if(candles.length<200){return}
  const closes=candles.map(c=>c.close),rsiArr=rsi(closes,14)
  interface Pos{side:"long"|"short";entryPrice:number;sizeUsdt:number;quantity:number;stopLoss:number;takeProfit:number;openedAt:number}
  let pos:Pos|null=null;const trades:Trade[]=[];let equity=10000,lastTime=0,lastDir:string|null=null

  for(let i=200;i<candles.length;i++){
    const window=candles.slice(0,i+1),snap=computeSnapshot(window,CFG),price=snap.price
    if(pos){const d=pos.side==="long"?1:-1;let ex=false,reason=""
      const r=rsiArr[i];ex=(pos.side==="long"&&r>=62)||(pos.side==="short"&&r<=38);if(ex)reason="rsi"
      if(pos.side==="long"?price<=pos.stopLoss:price>=pos.stopLoss){ex=true;reason="sl"}
      if(pos.side==="long"?price>=pos.takeProfit:price<=pos.takeProfit){ex=true;reason="tp"}
      if(ex){const gp=(price-pos.entryPrice)*d*pos.quantity,f=pos.entryPrice*pos.quantity*TAKER_FEE+price*pos.quantity*TAKER_FEE
        trades.push({side:pos.side,entryPrice:pos.entryPrice,exitPrice:price,pnl:gp-f,exitReason:reason,openedAt:pos.openedAt});equity+=gp-f;pos=null;lastDir=null}}
    if(!pos){let dir:"long"|"short"|null=null
      const r=rsiArr[i];if(r<=20)dir="long";else if(r>=80)dir="short"
      if(dir){const tooSoon=dir===lastDir&&candles[i].time-lastTime<3600
        if(!tooSoon){const q=(500*5)/price,atrVal=snap.atr
          const sl=dir==="long"?price-atrVal*1.0:price+atrVal*1.0,tp=dir==="long"?price+atrVal*3.0:price-atrVal*3.0
          pos={side:dir,entryPrice:price,sizeUsdt:500,quantity:q,stopLoss:sl,takeProfit:tp,openedAt:candles[i].time};lastTime=candles[i].time;lastDir=dir}}}
  }
  if(pos){const lp=candles[candles.length-1].close;const d=pos.side==="long"?1:-1;const gp=(lp-pos.entryPrice)*d*pos.quantity,f=pos.entryPrice*pos.quantity*TAKER_FEE+lp*pos.quantity*TAKER_FEE;trades.push({side:pos.side,entryPrice:pos.entryPrice,exitPrice:lp,pnl:gp-f,exitReason:"eob",openedAt:pos.openedAt});equity+=gp-f}
  const pnl=trades.reduce((s,t)=>s+t.pnl,0),wins=trades.filter(t=>t.pnl>0)
  console.log(`${sym.padEnd(12)} MEANREV | ${trades.length.toString().padStart(3)} trades  WR ${trades.length>0?(wins.length/trades.length*100).toFixed(0):"0"}%  PnL ${pnl>=0?"+":""}${pnl.toFixed(2).padStart(7)}  Equity ${equity.toFixed(2)}  Return ${((equity-10000)/100).toFixed(1)}%`)
}

async function runAll(){
  console.log("══════════════ GRID STRATEGY (15-min, 0.3% spacing) ══════════════")
  for(const s of ["BTC_USDT","ETH_USDT","SOL_USDT","BNB_USDT","ADA_USDT","XRP_USDT","DOGE_USDT","LTC_USDT","AVAX_USDT","LINK_USDT"]){try{await testGrid(s,"Min15")}catch(e){console.log(`${s}: error`)}}
  console.log("\n══════════════ MEAN-REVERSION (RSI 20/80, exit 62) ══════════════")
  for(const s of ["PEPE_USDT","DOGE_USDT","SHIB_USDT","FLOKI_USDT","BONK_USDT","WIF_USDT","PEOPLE_USDT","BTC_USDT","ETH_USDT","SOL_USDT"]){try{await testMeanRev(s,"Min15")}catch(e){console.log(`${s}: error`)}}
}
runAll().catch(console.error)
