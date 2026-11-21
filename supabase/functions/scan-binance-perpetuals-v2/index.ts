import "jsr:@supabase/functions-js/edge-runtime.d.ts";
import { createClient } from "https://esm.sh/@supabase/supabase-js@2.57.0";

const cors = {"Access-Control-Allow-Origin":"*","Access-Control-Allow-Headers":"authorization, x-client-info, apikey, content-type","Access-Control-Allow-Methods":"POST, OPTIONS","Content-Type":"application/json"};
const reply=(body:unknown,status=200)=>new Response(JSON.stringify(body),{status,headers:cors});
const BASE="https://fapi.binance.com";
const get=async(path:string)=>{const r=await fetch(BASE+path,{headers:{Accept:"application/json"}});if(!r.ok)throw new Error("Binance "+r.status+" "+path);return await r.json();};
const opt=async(path:string)=>{try{return await get(path);}catch{return null;}};
const ema=(v:number[],p:number)=>{if(v.length<p)return null;const k=2/(p+1);let x=v.slice(0,p).reduce((a,b)=>a+b,0)/p;for(let i=p;i<v.length;i++)x=v[i]*k+x*(1-k);return x;};
const rsi=(v:number[],p=14)=>{if(v.length<p+1)return null;let g=0,l=0;for(let i=1;i<=p;i++){const d=v[i]-v[i-1];if(d>0)g+=d;else l-=d;}let ag=g/p,al=l/p;for(let i=p+1;i<v.length;i++){const d=v[i]-v[i-1];ag=(ag*(p-1)+Math.max(0,d))/p;al=(al*(p-1)+Math.max(0,-d))/p;}return al===0?100:100-100/(1+ag/al);};
const atr=(k:any[],p=14)=>{if(k.length<p+1)return null;const a:number[]=[];for(let i=1;i<k.length;i++){const h=+k[i][2],l=+k[i][3],pc=+k[i-1][4];a.push(Math.max(h-l,Math.abs(h-pc),Math.abs(l-pc)));}return a.slice(-p).reduce((x,y)=>x+y,0)/p;};
function stats(raw:any[]){const k=raw.slice(0,-1),c=k.map(x=>+x[4]),last=k.at(-1),e20=ema(c,20),e50=ema(c,50),r=rsi(c),a=atr(k);const trend=e20&&e50?(+last[4]>e20&&e20>e50?"BULLISH":+last[4]<e20&&e20<e50?"BEARISH":"NEUTRAL"):"UNAVAILABLE";const recent=k.slice(-12),swingLow=Math.min(...recent.map(x=>+x[3])),swingHigh=Math.max(...recent.map(x=>+x[2]));const prev=k.at(-2);return {k,c,last,e20,e50,r,a,trend,swingLow,swingHigh,prev};}
function bookStats(d:any){if(!d?.bids?.length||!d?.asks?.length)return null;const b=d.bids.reduce((s:number,x:any)=>s+ +x[0]*+x[1],0),a=d.asks.reduce((s:number,x:any)=>s+ +x[0]*+x[1],0),bb=+d.bids[0][0],ba=+d.asks[0][0],mid=(bb+ba)/2;return {imbalance:(b-a)/(b+a),spreadBps:(ba-bb)/mid*10000};}
function evaluate(x:any){
 const {s5,s15,s1,s4,book,oiChange,taker,funding,btcRegime,price}=x;
 const reasons:string[]=[],filters:any={};let score=0;
 const side=s4.trend===s1.trend&&s1.trend!=="NEUTRAL"&&s1.trend!=="UNAVAILABLE"?s1.trend:null;
 filters.btc_regime=btcRegime;filters.trend_alignment=side??"MIXED";
 if(!side)return {side:"WATCH",score:0,reasons:["4H and 1H trend are not aligned"],filters};
 if(btcRegime!=="NEUTRAL"&&btcRegime!==side){return {side:"WATCH",score:0,reasons:["BTC market regime conflicts with altcoin direction"],filters};}
 score+=20;reasons.push("4H and 1H trend alignment");filters.trend=true;
 const long=side==="BULLISH",dir=long?"LONG":"SHORT";
 const momentum=long?(s5.r!==null&&s5.r>=50&&s5.r<=68):(s5.r!==null&&s5.r>=32&&s5.r<=50);
 if(momentum){score+=15;reasons.push("5M momentum confirms direction");}else return {side:"WATCH",score,reasons:["5M momentum is not in confirmation range"],filters};
 const candle15=s15.k.at(-1),prior15=s15.k.at(-2);
 const pullback=long?(+candle15[3]<=s15.e20*1.003&&+candle15[4]>s15.e20&&+candle15[4]>+candle15[1]&&+candle15[4]>+prior15[2]):(+candle15[2]>=s15.e20*0.997&&+candle15[4]<s15.e20&&+candle15[4]<+candle15[1]&&+candle15[4]<+prior15[3]);
 if(pullback){score+=25;reasons.push("15M EMA20 pullback and confirmation candle");}else return {side:"WATCH",score,reasons:["No confirmed 15M pullback/retest"],filters};
 if(book&&book.spreadBps<=8&&((long&&book.imbalance>=0.05)||(!long&&book.imbalance<=-0.05))){score+=10;reasons.push("Order-book imbalance and spread confirm");filters.orderbook=true;}else return {side:"WATCH",score,reasons:["Order-book confirmation or spread filter failed"],filters};
 if(taker!==null&&((long&&taker>=1.02)||(!long&&taker<=0.98))){score+=10;reasons.push("Taker flow confirms direction");filters.taker=true;}else return {side:"WATCH",score,reasons:["Taker flow does not confirm"],filters};
 if(oiChange!==null&&oiChange>=0.10){score+=10;reasons.push("Open interest increasing with directional move");filters.open_interest=true;}else return {side:"WATCH",score,reasons:["Open-interest confirmation unavailable or weak"],filters};
 if(funding!==null&&Math.abs(funding)<=0.0008){score+=5;reasons.push("Funding not excessively crowded");filters.funding=true;}else return {side:"WATCH",score,reasons:["Funding is crowded or unavailable"],filters};
 if(price<=0||!s15.a||!s1.a)return {side:"WATCH",score,reasons:["ATR data unavailable"],filters};
 const structural=long?s15.swingLow:s15.swingHigh;
 const atrBuffer=s15.a*0.25;
 const stop=long?structural-atrBuffer:structural+atrBuffer;
 const risk=Math.abs(price-stop),riskPct=risk/price*100;
 if(!(risk>0&&riskPct>=0.25&&riskPct<=2.5)){return {side:"WATCH",score,reasons:["Structural stop distance outside 0.25%-2.5%"],filters};}
 const target=long?price+3*risk:price-3*risk;
 const room=long?(s1.swingHigh-price)/risk:(price-s1.swingLow)/risk;
 if(room<3){return {side:"WATCH",score,reasons:["Insufficient 1H market-structure room for 3R"],filters};}
 score+=5;reasons.push("Structural stop and unobstructed 3R target validated");
 filters.risk_reward=3;filters.risk_pct=1;filters.risk_distance_pct=riskPct;filters.room_to_target_r=room;
 return {side:dir,score,reasons,filters,entry:price,stop,target,riskReward:3,riskPct:1};
}
async function updateTrades(db:any){
 const {data:trades,error}=await db.from("v2_paper_trades").select("*").eq("status","OPEN").limit(250);
 if(error)throw error;let checked=0,closed=0;const groups=new Map<string,any[]>();
 for(const t of trades??[]){const a=groups.get(t.symbol)||[];a.push(t);groups.set(t.symbol,a);}
 for(const [symbol,list] of groups){const start=Math.floor(Math.min(...list.map(t=>new Date(t.last_checked_at).getTime()))/60000)*60000+60000;const bars=await opt(`/fapi/v1/klines?symbol=${symbol}&interval=1m&startTime=${start}&limit=1000`);if(!Array.isArray(bars))continue;const now=Date.now(),closedBars=bars.filter(k=>+k[6]<now);
 for(const t of list){const relevant=closedBars.filter(k=>+k[0]>=Math.floor(new Date(t.last_checked_at).getTime()/60000)*60000+60000);if(!relevant.length)continue;let outcome:any=null;
 for(const k of relevant){const hi=+k[2],lo=+k[3],tp=t.side==="LONG"?hi>=+t.take_profit:lo<=+t.take_profit,sl=t.side==="LONG"?lo<=+t.stop_loss:hi>=+t.stop_loss;if(tp||sl){const win=tp&&!sl,both=tp&&sl,exit=win?t.take_profit:t.stop_loss;outcome={status:win?"WIN":"LOSS",exit_price:exit,exit_at:new Date(+k[6]).toISOString(),exit_reason:both?"BOTH_HIT_SAME_CANDLE":win?"TAKE_PROFIT":"STOP_LOSS",realized_r:win?3:-1,realized_pct:win?3:-1,last_checked_at:new Date(+k[6]).toISOString(),updated_at:new Date().toISOString(),duration_seconds:Math.max(0,Math.floor((+k[6]-new Date(t.signal_created_at).getTime())/1000))};break;}}
 const last=relevant.at(-1),patch=outcome??{last_checked_at:new Date(+last[6]).toISOString(),updated_at:new Date().toISOString()};const {error:e}=await db.from("v2_paper_trades").update(patch).eq("id",t.id).eq("status","OPEN");if(e)throw e;checked++;if(outcome)closed++;
 }}return {checked,closed};
}
Deno.serve(async(req)=>{if(req.method==="OPTIONS")return new Response("ok",{headers:cors});if(req.method!=="POST")return reply({error:"POST required"},405);
 const url=Deno.env.get("SUPABASE_URL"),key=Deno.env.get("SUPABASE_SERVICE_ROLE_KEY");if(!url||!key)return reply({error:"Server configuration missing"},500);const db=createClient(url,key,{auth:{persistSession:false}});
 const {data:run,error}=await db.from("v2_scan_runs").insert({status:"running"}).select("id").single();if(error||!run)return reply({error:error?.message??"Could not start V2 scan"},500);
 try{
 const [info,tickers,premiums,btc5,btc15,btc1,btc4]=await Promise.all([get("/fapi/v1/exchangeInfo"),get("/fapi/v1/ticker/24hr"),get("/fapi/v1/premiumIndex"),get("/fapi/v1/klines?symbol=BTCUSDT&interval=5m&limit=100"),get("/fapi/v1/klines?symbol=BTCUSDT&interval=15m&limit=100"),get("/fapi/v1/klines?symbol=BTCUSDT&interval=1h&limit=100"),get("/fapi/v1/klines?symbol=BTCUSDT&interval=4h&limit=100")]);
 const btc=evaluateBTC(btc1,btc4);const active=new Set(info.symbols.filter((s:any)=>s.status==="TRADING"&&s.contractType==="PERPETUAL"&&s.quoteAsset==="USDT").map((s:any)=>s.symbol));const selected=tickers.filter((t:any)=>active.has(t.symbol)&&+t.quoteVolume>3000000).sort((a:any,b:any)=>+b.quoteVolume-+a.quoteVolume).slice(0,60);const pmap=new Map(premiums.map((p:any)=>[p.symbol,p]));let signals=0;
 for(let i=0;i<selected.length;i+=4){const batch=selected.slice(i,i+4);const out=await Promise.all(batch.map(async(t:any)=>{
 const sym=t.symbol,[k5,k15,k1,k4,depth,oi,taker]=await Promise.all([opt(`/fapi/v1/klines?symbol=${sym}&interval=5m&limit=100`),opt(`/fapi/v1/klines?symbol=${sym}&interval=15m&limit=100`),opt(`/fapi/v1/klines?symbol=${sym}&interval=1h&limit=100`),opt(`/fapi/v1/klines?symbol=${sym}&interval=4h&limit=100`),opt(`/fapi/v1/depth?symbol=${sym}&limit=20`),opt(`/futures/data/openInterestHist?symbol=${sym}&period=5m&limit=2`),opt(`/futures/data/takerlongshortRatio?symbol=${sym}&period=5m&limit=1`)]);
 if(![k5,k15,k1,k4].every(Array.isArray))return null;const s5=stats(k5),s15=stats(k15),s1=stats(k1),s4=stats(k4),b=bookStats(depth),oiOld=oi?.length>1?+oi[0].sumOpenInterestValue:null,oiNew=oi?.length?+oi.at(-1).sumOpenInterestValue:null,oiChange=oiOld&&oiNew!==null?(oiNew-oiOld)/oiOld*100:null,tr=taker?.[0]?+taker[0].buySellRatio:null,pr=pmap.get(sym),fund=pr?+pr.lastFundingRate:null;
 return {symbol:sym,price:+t.lastPrice,evaluation:evaluate({s5,s15,s1,s4,book:b,oiChange,taker:tr,funding:fund,btcRegime:btc,price:+t.lastPrice}),timeframes:{'5m':{trend:s5.trend,rsi:s5.r},'15m':{trend:s15.trend,rsi:s15.r},'1h':{trend:s1.trend,rsi:s1.r},'4h':{trend:s4.trend,rsi:s4.r}},metrics:{orderbook_imbalance:b?.imbalance??null,spread_bps:b?.spreadBps??null,oi_change_pct:oiChange,taker_ratio:tr,funding_rate:fund}};
 }));
 const candidates=(out.filter(Boolean) as any[]).map(x=>({scan_id:run.id,symbol:x.symbol,side:x.evaluation.side,score:x.evaluation.score,confidence_label:x.evaluation.score>=85?"HIGH":x.evaluation.score>=75?"MEDIUM":"LOW",entry_price:x.evaluation.entry??x.price,stop_loss:x.evaluation.stop??null,take_profit:x.evaluation.target??null,risk_reward:x.evaluation.riskReward??null,risk_pct:1,risk_distance_pct:x.evaluation.filters.risk_distance_pct??null,reasons:x.evaluation.reasons,filters:{...x.evaluation.filters,timeframes:x.timeframes,metrics:x.metrics},validation_status:x.evaluation.side==="WATCH"?"WATCH_ONLY":"V2_PAPER_ONLY"}));
 if(candidates.length){const {data:inserted,error:ie}=await db.from("v2_trade_candidates").insert(candidates).select("id,symbol,side,score,confidence_label,entry_price,stop_loss,take_profit,risk_reward,created_at,filters");if(ie)throw ie;const trades=(inserted??[]).filter((c:any)=>["LONG","SHORT"].includes(c.side)&&c.risk_reward===3&&c.stop_loss&&c.take_profit).map((c:any)=>({source_candidate_id:c.id,scan_id:run.id,symbol:c.symbol,side:c.side,score:c.score,confidence_label:c.confidence_label,entry_price:c.entry_price,stop_loss:c.stop_loss,take_profit:c.take_profit,risk_reward:3,risk_pct:1,signal_created_at:c.created_at,last_checked_at:c.created_at}));if(trades.length){const {error:te}=await db.from("v2_paper_trades").insert(trades);if(te)throw te;signals=trades.length;}}
 }
 const monitor=await updateTrades(db);await db.from("v2_scan_runs").update({status:"completed",completed_at:new Date().toISOString(),symbols_scanned:selected.length,detailed_analyses:Math.min(selected.length,60),signals_generated:signals,metadata:{btc_regime:btc,scanner_version:"V2",risk_pct:1,target_r:3}}).eq("id",run.id);
 return reply({ok:true,version:"V2",scan_id:run.id,symbols_scanned:selected.length,signals_generated:signals,btc_regime:btc,paper_trades_checked:monitor.checked,paper_trades_closed:monitor.closed,real_orders:false,note:"Separate V2 paper strategy. 1% simulated risk, fixed 3R target, no exchange order execution."});
 }catch(e){const m=e instanceof Error?e.message:String(e);await db.from("v2_scan_runs").update({status:"failed",completed_at:new Date().toISOString(),error_message:m}).eq("id",run.id);return reply({error:"V2 scan failed",detail:m},502);}
});
function evaluateBTC(k1:any[],k4:any[]){const a=stats(k1),b=stats(k4);return a.trend===b.trend&&a.trend!=="UNAVAILABLE"?a.trend:"NEUTRAL";}
