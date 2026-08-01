import { computeSnapshot } from "./lib/indicators"
const TAKER_FEE=0.0002

async function fetchAll(sym:string,tf:string,days:number):Promise<any[]>{
  const isec={Min15:900}[tf]??900;const es=Math.floor(Date.now()/1000),ss=es-days*86400
  const all:any[]=[];let fe=es
  while(true){const fs=Math.max(ss,fe-2000*isec)
    const u=`https://contract.mexc.com/api/v1/contract/kline/${sym}?interval=${tf}&start=${fs}&end=${fe}`
    try{const r=await fetch(u);const j=await r.json() as any
      if(!j.success||!j.data?.time?.length)break
      const{time,open,high,low,close,vol}=j.data
      for(let i=0;i<time.length;i++){if(time[i]>=ss&&time[i]<=es)all.push({time:time[i],open:open[i],high:high[i],low:low[i],close:close[i],volume:vol[i]??0})}
      if(time[0]<=ss||time.length<100)break;fe=time[0]-isec}catch{break}}
  all.sort((a:any,b:any)=>a.time-b.time)
  return all.filter((c:any,i:number,a:any[])=>i===0||c.time!==a[i-1].time)
}

async function testGrid(sym:string,levels:number,spacingPct:number,perLevel:number){
  const candles=await fetchAll(sym,"Min15",30)
  if(candles.length<200){console.log(`${levels} levels: only ${candles.length} candles`);return}
  interface Trade{entryPrice:number;exitPrice:number;pnl:number}
  const trades:Trade[]=[];let equity=10000
  let gBuys:{price:number,qty:number}[]=[],gSells:{price:number,qty:number,buyPrice:number}[]=[]
  const lev=5
  for(let i=200;i<candles.length;i++){
    const price=candles[i].close
    if(gBuys.length===0&&gSells.length===0){for(let l=1;l<=levels;l++){const bp=price*(1-spacingPct/100*l);gBuys.push({price:bp,qty:(perLevel*lev)/bp})}}
    for(const b of [...gBuys]){if(price<=b.price){gBuys=gBuys.filter(x=>x!==b);gSells.push({price:b.price*(1+spacingPct/100),qty:b.qty,buyPrice:b.price})}}
    for(const s of [...gSells]){if(price>=s.price){gSells=gSells.filter(x=>x!==s)
      const gp=(s.price-s.buyPrice)*s.qty,f=s.buyPrice*s.qty*TAKER_FEE+s.price*s.qty*TAKER_FEE
      trades.push({entryPrice:s.buyPrice,exitPrice:s.price,pnl:gp-f});equity+=gp-f;gBuys.push({price:s.buyPrice,qty:s.qty})}}
  }
  const lp=candles[candles.length-1].close;for(const s of gSells){const gp=(lp-s.buyPrice)*s.qty,f=s.buyPrice*s.qty*TAKER_FEE+lp*s.qty*TAKER_FEE;trades.push({entryPrice:s.buyPrice,exitPrice:lp,pnl:gp-f});equity+=gp-f}
  const pnl=trades.reduce((s,t)=>s+t.pnl,0),wins=trades.filter(t=>t.pnl>0)
  const deployed=levels*perLevel*lev
  console.log(`Levels ${levels.toString().padStart(2)} | ${trades.length.toString().padStart(3)} trades  WR ${(wins.length/trades.length*100).toFixed(0)}%  PnL ${pnl>=0?"+":""}${pnl.toFixed(2).padStart(8)}  Equity ${equity.toFixed(2)}  Return ${((equity-10000)/100).toFixed(1)}%  Deployed $${deployed}`)
}

async function run(){
  console.log("BANK_USDT Min15 — 0.5% spacing, varying levels ($500/level, 5x leverage = $2,500 deployed/level)")
  console.log("")
  for(const levels of [2,3,5,7,10,15,20]){
    try{await testGrid("BANK_USDT",levels,0.5,500)}catch(e){console.log(`${levels} levels: error`)}
  }
}
run().catch(console.error)
