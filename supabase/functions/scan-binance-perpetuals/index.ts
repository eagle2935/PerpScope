import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";
import { riskSetup } from "./risk-model.ts";

const cors = {
  "Access-Control-Allow-Origin": "*",
  "Access-Control-Allow-Headers": "authorization, x-client-info, apikey, content-type",
  "Access-Control-Allow-Methods": "POST, OPTIONS",
  "Content-Type": "application/json",
};
const json = (body: unknown, status = 200) => new Response(JSON.stringify(body), { status, headers: cors });
const BASE = "https://fapi.binance.com";

function ema(values: number[], period: number): number | null {
  if (values.length < period) return null;
  const k = 2 / (period + 1);
  let value = values.slice(0, period).reduce((a,b)=>a+b,0) / period;
  for (let i=period;i<values.length;i++) value = values[i]*k + value*(1-k);
  return value;
}
function rsi(values: number[], period=14): number | null {
  if (values.length < period+1) return null;
  let gain=0, loss=0;
  for(let i=1;i<=period;i++){const d=values[i]-values[i-1];if(d>0)gain+=d;else loss-=d;}
  let ag=gain/period, al=loss/period;
  for(let i=period+1;i<values.length;i++){const d=values[i]-values[i-1];ag=(ag*(period-1)+Math.max(d,0))/period;al=(al*(period-1)+Math.max(-d,0))/period;}
  if(al===0)return 100;
  return 100-(100/(1+ag/al));
}
function atr(candles: any[], period=14): number | null {
  if(candles.length < period+1)return null;
  const tr:number[]=[];
  for(let i=1;i<candles.length;i++){const h=Number(candles[i][2]),l=Number(candles[i][3]),pc=Number(candles[i-1][4]);tr.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}
  return tr.slice(-period).reduce((a,b)=>a+b,0)/period;
}
function indicators(raw: any[]) {
  // Ignore the currently forming candle to avoid unstable indicator values.
  const closed = raw.slice(0,-1);
  const closes=closed.map(x=>Number(x[4]));
  const e20=ema(closes,20), e50=ema(closes,50);
  const e12=ema(closes,12), e26=ema(closes,26);
  const macdLine=e12!==null&&e26!==null?e12-e26:null;
  const macdSeries:number[]=[];
  if(closes.length>=35){
    for(let i=25;i<closes.length;i++){const a=ema(closes.slice(0,i+1),12),b=ema(closes.slice(0,i+1),26);if(a!==null&&b!==null)macdSeries.push(a-b);}
  }
  const signal=macdSeries.length?ema(macdSeries,9):null;
  const hist=macdLine!==null&&signal!==null?macdLine-signal:null;
  const last=closes.at(-1)??null;
  const trend=e20!==null&&e50!==null&&last!==null?(last>e20&&e20>e50?"BULLISH":last<e20&&e20<e50?"BEARISH":"NEUTRAL"):"UNAVAILABLE";
  return {close:last,ema20:e20,ema50:e50,rsi14:rsi(closes),macd:macdLine,macd_signal:signal,macd_histogram:hist,atr14:atr(closed),trend,candles:closed.length};
}
async function get(path:string) {
  let lastError: unknown;
  for (let attempt = 0; attempt < 3; attempt++) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 8000);
    try {
      const res = await fetch(BASE + path, {
        headers: { Accept: "application/json" },
        signal: controller.signal,
      });
      if (res.status === 429 || res.status >= 500) {
        const retryAfter = Number(res.headers.get("Retry-After") || 0);
        if (attempt < 2) {
          await new Promise(resolve => setTimeout(resolve, Math.min(2500, retryAfter * 1000 || 250 * (2 ** attempt))));
          continue;
        }
      }
      if (!res.ok) throw new Error("Binance " + res.status + " " + path);
      return await res.json();
    } catch (error) {
      lastError = error;
      if (attempt < 2) await new Promise(resolve => setTimeout(resolve, 200 * (2 ** attempt)));
    } finally {
      clearTimeout(timer);
    }
  }
  throw lastError instanceof Error ? lastError : new Error("Binance request failed: " + path);
}
async function optional(path:string) {
  try { return await get(path); }
  catch (error) { console.warn("Optional Binance data unavailable", path, error); return null; }
}
function orderbook(depth:any) {
  if(!depth?.bids?.length||!depth?.asks?.length)return null;
  const bid=depth.bids.reduce((s:any,x:any)=>s+Number(x[0])*Number(x[1]),0);
  const ask=depth.asks.reduce((s:any,x:any)=>s+Number(x[0])*Number(x[1]),0);
  const bestBid=Number(depth.bids[0][0]),bestAsk=Number(depth.asks[0][0]),mid=(bestBid+bestAsk)/2;
  return {bidUsd:bid,askUsd:ask,imbalance:(bid-ask)/(bid+ask),spreadBps:mid>0?(bestAsk-bestBid)/mid*10000:null};
}



// Paper-trade tracking only: this records and evaluates signals; it never places orders.
async function createPaperTrades(supabase: any, scanId: string) {
  const { data: candidates, error } = await supabase
    .from("trade_candidates")
    .select("id,scan_id,symbol,side,score,confidence_label,entry_price,stop_loss,take_profit,risk_reward,created_at")
    .eq("scan_id", scanId)
    .in("side", ["LONG", "SHORT"])
    .not("stop_loss", "is", null)
    .not("take_profit", "is", null);
  if (error) throw error;
  if (!candidates?.length) return 0;
  const records = candidates.filter((c: any) => {
    const entry = Number(c.entry_price), stop = Number(c.stop_loss), target = Number(c.take_profit);
    const rr = Math.abs(target - entry) / Math.abs(entry - stop);
    return Number.isFinite(entry) && entry > 0 && Number.isFinite(stop) && stop > 0
      && Number.isFinite(target) && Number.isFinite(rr) && Math.abs(rr - 3) <= 0.01
      && (c.side === "LONG" ? stop < entry && target > entry : stop > entry && target < entry);
  }).map((c: any) => ({
    source_candidate_id: c.id, scan_id: c.scan_id, symbol: c.symbol, side: c.side,
    score: c.score, confidence_label: c.confidence_label, entry_price: c.entry_price,
    simulated_account_usd: 200, simulated_risk_usd: 2,
    simulated_position_usd: Number(c.entry_price)>0 ? Number((2*Number(c.entry_price)/Math.abs(Number(c.entry_price)-Number(c.stop_loss))).toFixed(2)) : null,
    stop_loss: c.stop_loss, take_profit: c.take_profit, risk_reward: c.risk_reward,
    signal_created_at: c.created_at, last_checked_at: c.created_at,
  }));
  if (!records.length) return 0;
  const { data, error: insertError } = await supabase.from("paper_trades")
    .upsert(records, { onConflict: "source_candidate_id", ignoreDuplicates: true }).select("id");
  if (insertError) throw insertError;
  return data?.length ?? 0;
}

async function updateOpenPaperTrades(supabase: any) {
  const { data: trades, error } = await supabase.from("paper_trades")
    .select("id,symbol,side,entry_price,stop_loss,take_profit,risk_reward,signal_created_at,last_checked_at,cycle_number")
    .eq("status", "OPEN").order("last_checked_at", { ascending: true }).limit(500);
  if (error) throw error;
  if (!trades?.length) return { checked: 0, completed: 0 };
  const bySymbol = new Map<string, any[]>();
  for (const trade of trades) {
    const list = bySymbol.get(trade.symbol) ?? [];
    list.push(trade); bySymbol.set(trade.symbol, list);
  }
  let checked = 0, completed = 0;
  const now = Date.now();
  for (const [symbol, group] of bySymbol) {
    const earliest = Math.min(...group.map((t: any) => new Date(t.last_checked_at).getTime()));
    const startTime = Math.floor(earliest / 60000) * 60000 + 60000;
    const candles = await optional(`/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${startTime}&limit=1000`);
    if (!Array.isArray(candles) || !candles.length) continue;
    const closed = candles.filter((k: any[]) => Number(k[6]) < now);
    if (!closed.length) continue;
    for (const trade of group) {
      const tradeStart = Math.floor(new Date(trade.last_checked_at).getTime() / 60000) * 60000 + 60000;
      const relevant = closed.filter((k: any[]) => Number(k[0]) >= tradeStart);
      if (!relevant.length) continue;
      let outcome: any = null;
      for (const k of relevant) {
        const high = Number(k[2]), low = Number(k[3]), closeTime = Number(k[6]);
        const hitTp = trade.side === "LONG" ? high >= Number(trade.take_profit) : low <= Number(trade.take_profit);
        const hitSl = trade.side === "LONG" ? low <= Number(trade.stop_loss) : high >= Number(trade.stop_loss);
        if (hitTp || hitSl) {
          const both = hitTp && hitSl, win = hitTp && !hitSl;
          outcome = {
            status: win ? "WIN" : "LOSS",
            exit_price: win ? trade.take_profit : trade.stop_loss,
            exit_at: new Date(closeTime).toISOString(),
            exit_reason: both ? "BOTH_HIT_SAME_CANDLE" : win ? "TAKE_PROFIT" : "STOP_LOSS",
            realized_r: win ? Number(trade.risk_reward ?? 2) : -1,
            simulated_pnl_usd: Number(((win ? Number(trade.risk_reward ?? 3) : -1) * Number(trade.simulated_risk_usd ?? 2)).toFixed(2)),
            duration_seconds: Math.max(0, Math.floor((closeTime - new Date(trade.signal_created_at).getTime()) / 1000)),
            last_checked_at: new Date(closeTime).toISOString(), updated_at: new Date().toISOString(),
          };
          break;
        }
      }
      const lastCandle = relevant[relevant.length - 1];
      const patch = outcome ?? { last_checked_at: new Date(Number(lastCandle[6])).toISOString(), updated_at: new Date().toISOString() };
      const { error: updateError } = await supabase.from("paper_trades").update(patch).eq("id", trade.id).eq("status", "OPEN");
      if (updateError) throw updateError;
      checked++; if (outcome) completed++;
    }
  }
  return { checked, completed };
}

Deno.serve(async(req)=>{
  if(req.method==="OPTIONS")return new Response("ok",{headers:cors});
  if(req.method!=="POST")return json({error:"POST required"},405);
  const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");
  if(!url||!key)return json({error:"Server configuration missing"},500);
  const supabase=createClient(url,key,{auth:{persistSession:false}});
  const cutoff=new Date(Date.now()-120000).toISOString();
  const { error: staleRunError } = await supabase.from("scan_runs")
    .update({ status: "failed", completed_at: new Date().toISOString(), error_message: "Scanner run exceeded the 2-minute lease and was marked stale." })
    .eq("status", "running").lt("started_at", cutoff);
  if (staleRunError) return json({ error: "Could not recover stale scanner runs", detail: staleRunError.message }, 500);
  const {data:activeRun}=await supabase.from("scan_runs").select("id").eq("status","running").gte("started_at",cutoff).limit(1).maybeSingle();
  if(activeRun)return json({ok:true,skipped:true,reason:"Previous V1 scan is still running",active_scan_id:activeRun.id},202);
  const {data:run,error:runErr}=await supabase.from("scan_runs").insert({status:"running"}).select("id").single();
  if(runErr||!run)return json({error:"Could not start scan",detail:runErr?.message},500);
  try {
    // Check exits before the slower market-wide scan so paper trades are updated first.
    const paperTradeUpdates = await updateOpenPaperTrades(supabase);
    const [exchangeInfo,tickers,premiums]=await Promise.all([
      get("/fapi/v1/exchangeInfo"),get("/fapi/v1/ticker/24hr"),get("/fapi/v1/premiumIndex")
    ]);
    const active=new Set(exchangeInfo.symbols.filter((s:any)=>s.status==="TRADING"&&s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT").map((s:any)=>s.symbol));
    const premiumMap=new Map(premiums.map((p:any)=>[p.symbol,p]));
    const selected=tickers.filter((t:any)=>active.has(t.symbol)&&Number(t.quoteVolume)>1_000_000).sort((a:any,b:any)=>Number(b.quoteVolume)-Number(a.quoteVolume)).slice(0,80);
    const rows:any[]=[],candidates:any[]=[],analyses:any[]=[];
    // Base market coverage for all 80 symbols; detailed technical and depth analysis for the 40 most liquid.
    for(let i=0;i<selected.length;i+=16){
      const batch=selected.slice(i,i+16);
      const enriched=await Promise.all(batch.map(async(t:any)=>{
        const p:any=premiumMap.get(t.symbol);
        const oiNow=await optional("/fapi/v1/openInterest?symbol="+t.symbol);
        const oi=oiNow?Number(oiNow.openInterest):null;
        return {t,p,oi,ratio:null};
      }));
      for(const x of enriched){
        const t=x.t,price=Number(t.lastPrice),change=Number(t.priceChangePercent),volume=Number(t.quoteVolume);
        rows.push({scan_id:run.id,symbol:t.symbol,last_price:price,price_change_pct:change,quote_volume:volume,funding_rate:x.p?Number(x.p.lastFundingRate):null,open_interest:x.oi,long_short_ratio:x.ratio});
      }
    }
    // Detailed requests are intentionally limited to the 40 highest-volume contracts with bounded concurrency.
    const detailed=selected.slice(0,40);
    for(let i=0;i<detailed.length;i+=8){
      const batch=detailed.slice(i,i+8);
      const result=await Promise.all(batch.map(async(t:any)=>{
        const symbol=t.symbol;
        const paths=[
          "/fapi/v1/klines?symbol="+symbol+"&interval=5m&limit=100",
          "/fapi/v1/klines?symbol="+symbol+"&interval=15m&limit=100",
          "/fapi/v1/klines?symbol="+symbol+"&interval=1h&limit=100",
          "/fapi/v1/klines?symbol="+symbol+"&interval=4h&limit=100",
          "/fapi/v1/depth?symbol="+symbol+"&limit=20",
          "/futures/data/openInterestHist?symbol="+symbol+"&period=5m&limit=2",
          "/futures/data/takerlongshortRatio?symbol="+symbol+"&period=5m&limit=1"
        ];
        const [k5,k15,k1h,k4h,depth,oiHist,taker]=await Promise.all(paths.map(optional));
        const tf:any={};
        if(k5)tf["5m"]=indicators(k5);
        if(k15)tf["15m"]=indicators(k15);
        if(k1h)tf["1h"]=indicators(k1h);
        if(k4h)tf["4h"]=indicators(k4h);
        const book=orderbook(depth);
        const oiOld=oiHist?.length>1?Number(oiHist[0].sumOpenInterestValue):null;
        const oiNew=oiHist?.length?Number(oiHist[oiHist.length-1].sumOpenInterestValue):null;
        const oiChange=oiOld&&oiNew!==null?(oiNew-oiOld)/oiOld*100:null;
        const takerRatio=taker?.[0]?Number(taker[0].buySellRatio):null;
        const longTrend=tf["4h"]?.trend,midTrend=tf["1h"]?.trend,shortTrend=tf["15m"]?.trend;
        const alignment=longTrend===midTrend&&midTrend===shortTrend&&longTrend!=="NEUTRAL"&&longTrend!=="UNAVAILABLE"?longTrend:"MIXED";
        const m5=tf["5m"],m15=tf["15m"];
        const momentumLong=!!m5&&m5.macd_histogram!==null&&m5.macd_histogram>0&&m5.rsi14>=50&&m5.rsi14<=75;
        const momentumShort=!!m5&&m5.macd_histogram!==null&&m5.macd_histogram<0&&m5.rsi14<=50&&m5.rsi14>=25;
        const longBook=!!book&&book.imbalance>=0.08,shortBook=!!book&&book.imbalance<=-0.08;
        const longTaker=takerRatio!==null&&takerRatio>=1.03,shortTaker=takerRatio!==null&&takerRatio<=0.97;
        const oiConfirmed=oiChange!==null&&oiChange>=0.15;
        const oiShortConfirmed=oiChange!==null&&oiChange>=0.15;
        const spreadConfirmed=!!book&&book.spreadBps!==null&&book.spreadBps<=5;
        const dataComplete=!!m5&&!!m15&&!!tf["1h"]&&!!tf["4h"]&&!!book&&!!oiHist?.length&&!!taker?.length;
        const pullbackLong=!!m15&&m15.close!==null&&m15.ema20!==null&&m15.atr14!==null&&m15.close>=m15.ema20&&Math.abs(m15.close-m15.ema20)<=m15.atr14*1.25;
        const pullbackShort=!!m15&&m15.close!==null&&m15.ema20!==null&&m15.atr14!==null&&m15.close<=m15.ema20&&Math.abs(m15.close-m15.ema20)<=m15.atr14*1.25;
        const price=Number(t.lastPrice),atr15=m15?.atr14??null;
        let side="WATCH",reasons:string[]=[],score=0,setup:any=null;
        if(alignment==="BULLISH"){score+=35;reasons.push("4h/1h/15m bullish alignment");}
        if(alignment==="BEARISH"){score+=35;reasons.push("4h/1h/15m bearish alignment");}
        if((alignment==="BULLISH"&&momentumLong)||(alignment==="BEARISH"&&momentumShort)){score+=15;reasons.push("5m momentum confirmation");}
        if((alignment==="BULLISH"&&longBook)||(alignment==="BEARISH"&&shortBook)){score+=15;reasons.push("Order-book imbalance confirms direction");}
        if((alignment==="BULLISH"&&longTaker)||(alignment==="BEARISH"&&shortTaker)){score+=10;reasons.push("Taker flow confirms direction");}
        if(oiConfirmed){score+=10;reasons.push("Open interest increasing");}
        if(Number(t.quoteVolume)>=10_000_000){score+=5;reasons.push("High liquidity");}
        if (alignment==="BULLISH" && momentumLong && pullbackLong && longBook && longTaker && oiConfirmed && spreadConfirmed && dataComplete) {
          setup = riskSetup("LONG", price, atr15);
          if (setup) { side="LONG"; score+=10; reasons.push("15m pullback, liquidity and 1:3 risk model validated"); }
        }
        if (alignment==="BEARISH" && momentumShort && pullbackShort && shortBook && shortTaker && oiShortConfirmed && spreadConfirmed && dataComplete) {
          setup = riskSetup("SHORT", price, atr15);
          if (setup) { side="SHORT"; score+=10; reasons.push("15m pullback, liquidity and 1:3 risk model validated"); }
        }
        if (!dataComplete) reasons.push("Required market data incomplete");
        if (!spreadConfirmed) reasons.push("Spread filter failed or unavailable");
        const quality=dataComplete?"complete":"partial";
        const analysis={scan_id:run.id,symbol, timeframe_data:tf,orderbook_imbalance:book?.imbalance??null,orderbook_bid_usd:book?.bidUsd??null,orderbook_ask_usd:book?.askUsd??null,spread_bps:book?.spreadBps??null,open_interest_usd:oiNew,open_interest_change_pct:oiChange,taker_buy_sell_ratio:takerRatio,liquidation_buy_usd:null,liquidation_sell_usd:null,liquidation_source:"live_public_websocket_in_dashboard_only",data_quality:quality,trend_alignment:alignment,signal_side:side,signal_score:score,risk_reward:setup?.rr??null,entry_price:setup?.entry??null,stop_loss:setup?.stop??null,take_profit:setup?.target??null,reasons};
        return {analysis,candidate:{scan_id:run.id,symbol,side,score,entry_price:setup?.entry??price,take_profit:setup?.target??null,stop_loss:setup?.stop??null,reasons,risk_reward:setup?.rr??null,confidence_label:score>=85?"HIGH":score>=70?"MEDIUM":"LOW",validation_status:side==="WATCH"?"WATCH_ONLY":"RISK_CHECKED_NOT_EXECUTED"}};
      }));
      for(const x of result){analyses.push(x.analysis);candidates.push(x.candidate);}
    }
    // Keep the watchlist complete: all 80 markets get a WATCH row; replace the top 20 with their validated results.
    const bySymbol=new Map(candidates.map(x=>[x.symbol,x]));
    for(const row of rows){if(!bySymbol.has(row.symbol))candidates.push({scan_id:run.id,symbol:row.symbol,side:"WATCH",score:0,entry_price:Number(row.last_price),take_profit:null,stop_loss:null,reasons:["Detailed analysis not run: outside top 40 by quote volume"],risk_reward:null,confidence_label:"LOW",validation_status:"WATCH_ONLY"});}
    const [snapRes,candRes,analysisRes]=await Promise.all([
      supabase.from("market_snapshots").insert(rows),
      supabase.from("trade_candidates").insert(candidates),
      supabase.from("market_analysis").insert(analyses)
    ]);
    if(snapRes.error)throw snapRes.error;if(candRes.error)throw candRes.error;if(analysisRes.error)throw analysisRes.error;
    const paperTradesCreated = await createPaperTrades(supabase, run.id);
    await supabase.from("scan_runs").update({status:"completed",completed_at:new Date().toISOString(),symbols_scanned:rows.length}).eq("id",run.id);
    return json({ok:true,scan_id:run.id,symbols_scanned:rows.length,detailed_analyses:analyses.length,validated_setups:candidates.filter(x=>x.side!=="WATCH").length,paper_trades_created:paperTradesCreated,paper_trades_checked:paperTradeUpdates.checked,paper_trades_completed:paperTradeUpdates.completed,liquidations:"Not stored by the scanner; public all-market WebSocket is shown live in dashboard while open.",note:"Paper trades are tracked from generated LONG/SHORT signals only. WATCH rows are excluded. A 1m candle touching both TP and SL is conservatively counted as a LOSS. No real orders are placed."});
  }catch(error){
    const message=error instanceof Error?error.message:JSON.stringify(error);
    await supabase.from("scan_runs").update({status:"failed",completed_at:new Date().toISOString(),error_message:message}).eq("id",run.id);
    return json({error:"Scan failed",detail:message,scan_id:run.id},502);
  }
});