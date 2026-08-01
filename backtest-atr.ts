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

function atr(candles:any[],period:number):number[]{
  const out:number[]=new Array(candles.length).fill(0);let prev=0
  for(let i=0;i<candles.length;i++){const c=candles[i],pc=i>0?candles[i-1].close:c.close
    const tr=Math.max(c.high-c.low,Math.abs(c.high-pc),Math.abs(c.low-pc))
    prev=i===0?tr:(prev*(period-1)+tr)/period;out[i]=prev}
  return out
}

async function run(){
  const candles=await fetchAll("BANK_USDT","Min15",30)
  const atrArr=atr(candles,14)
  
  // Calculate ATR as % of price for the last 30 days
  const atrPcts:number[]=[]
  for(let i=200;i<candles.length;i++){
    atrPcts.push(atrArr[i]/candles[i].close*100)
  }
  
  const avgAtrPct=atrPcts.reduce((a,b)=>a+b,0)/atrPcts.length
  const sorted=[...atrPcts].sort((a,b)=>a-b)
  const median=sorted[Math.floor(sorted.length/2)]
  const p25=sorted[Math.floor(sorted.length*0.25)]
  const p75=sorted[Math.floor(sorted.length*0.75)]
  const min=Math.min(...atrPcts),max=Math.max(...atrPcts)
  
  console.log("BANK_USDT 15-min ATR as % of price (last 30 days):")
  console.log(`  Average: ${avgAtrPct.toFixed(2)}%`)
  console.log(`  Median:  ${median.toFixed(2)}%`)
  console.log(`  25th:    ${p25.toFixed(2)}%`)
  console.log(`  75th:    ${p75.toFixed(2)}%`)
  console.log(`  Range:   ${min.toFixed(2)}% – ${max.toFixed(2)}%`)
  console.log("")
  console.log("To get ~0.5% spacing with ATR-based spacing:")
  console.log(`  If ATR = ${avgAtrPct.toFixed(2)}% of price, then 0.5% / ${avgAtrPct.toFixed(2)}% = ${(0.5/avgAtrPct).toFixed(1)}x ATR`)
  console.log(`  Using median ATR: 0.5% / ${median.toFixed(2)}% = ${(0.5/median).toFixed(1)}x ATR`)
  console.log("")
  console.log("Recommendation: gridRangeAtrMult = 1.0 to 1.5 (gives 0.3-0.75% typical spacing)")
}
run().catch(console.error)
