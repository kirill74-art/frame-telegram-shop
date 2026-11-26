const express = require("express");
const { Telegraf, Markup } = require("telegraf");
const crypto = require("crypto");
const path = require("path");

const app = express();
const PORT = Number(process.env.PORT || 10000);
const BOT_TOKEN = process.env.BOT_TOKEN;
const MINI_APP_URL = process.env.MINI_APP_URL;
const OTCHARTS_API_KEY = process.env.OTCHARTS_API_KEY;

if (!BOT_TOKEN) throw new Error("Не задан BOT_TOKEN");
if (!MINI_APP_URL) throw new Error("Не задан MINI_APP_URL");

const bot = new Telegraf(BOT_TOKEN);
app.use(express.json({ limit: "32kb" }));
app.use(express.static(__dirname));

const ALLOWED_SYMBOLS = new Set([
  "EURUSD_otc","GBPUSD_otc","USDJPY_otc","AUDUSD_otc","USDCAD_otc",
  "EURGBP_otc","EURJPY_otc","GBPJPY_otc","NZDUSD_otc","USDCHF_otc",
  "EURUSD","GBPUSD","USDJPY","AUDUSD","USDCAD","EURGBP","EURJPY","GBPJPY"
]);
const TIMEFRAMES = new Set([60, 300, 900]);
const cache = new Map();
const CACHE_MS = 12000;

function verifyTelegramData(initData) {
  if (!initData || typeof initData !== "string" || !BOT_TOKEN) return null;
  const params = new URLSearchParams(initData);
  const hash = params.get("hash");
  if (!hash || !/^[a-f0-9]{64}$/i.test(hash)) return null;
  params.delete("hash");
  const check = [...params.entries()].sort(([a],[b]) => a.localeCompare(b))
    .map(([k,v]) => `${k}=${v}`).join("\n");
  const secret = crypto.createHmac("sha256", "WebAppData").update(BOT_TOKEN).digest();
  const expected = crypto.createHmac("sha256", secret).update(check).digest();
  const received = Buffer.from(hash, "hex");
  if (expected.length !== received.length || !crypto.timingSafeEqual(expected, received)) return null;
  const authDate = Number(params.get("auth_date"));
  if (!Number.isFinite(authDate) || authDate <= 0 || Date.now()/1000-authDate > 86400 || authDate-Date.now()/1000 > 60) return null;
  try {
    const user = JSON.parse(params.get("user") || "{}");
    return Number.isSafeInteger(user.id) && user.id > 0 ? user : null;
  } catch { return null; }
}

function authenticate(req,res,next) {
  const user = verifyTelegramData(req.get("X-Telegram-Init-Data"));
  if (!user) return res.status(401).json({ error: "Открой SIGNAL AI через Telegram." });
  req.telegramUser = user;
  next();
}

async function otcRequest(endpoint, params = {}) {
  if (!OTCHARTS_API_KEY) {
    const error = new Error("Источник котировок пока не подключён. Добавь OTCHARTS_API_KEY в Render.");
    error.status = 503;
    throw error;
  }
  const url = new URL(endpoint, "https://otcharts.com");
  for (const [key,value] of Object.entries(params)) url.searchParams.set(key, String(value));
  const response = await fetch(url, {
    headers: { Authorization: `Bearer ${OTCHARTS_API_KEY}`, Accept: "application/json", "User-Agent": "SIGNAL-AI/1.0" },
    signal: AbortSignal.timeout(12000)
  });
  const data = await response.json().catch(() => ({}));
  if (!response.ok) {
    const error = new Error(data.error || `Источник котировок ответил кодом ${response.status}`);
    error.status = response.status === 429 ? 429 : response.status >= 500 ? 502 : 503;
    throw error;
  }
  return data;
}

function ema(values, period) {
  const k = 2/(period+1);
  let result = values[0];
  for (let i=1;i<values.length;i++) result = values[i]*k + result*(1-k);
  return result;
}
function rsi(values, period=14) {
  let gains=0, losses=0;
  for(let i=values.length-period;i<values.length;i++){
    const delta=values[i]-values[i-1];
    if(delta>0) gains+=delta; else losses-=delta;
  }
  if(losses===0) return 100;
  const rs=(gains/period)/(losses/period);
  return 100-(100/(1+rs));
}
function analyze(candles, symbol, tf, isOpen) {
  if (!isOpen) return { direction:"none", reason:"Актив сейчас закрыт у источника котировок." };
  if (!Array.isArray(candles) || candles.length < 35) return { direction:"none", reason:"Недостаточно свечей для анализа." };
  const bars = candles.slice().sort((a,b)=>Number(a.time)-Number(b.time));
  const last = bars[bars.length-1];
  const now = Math.floor(Date.now()/1000);
  if (!last || !Number.isFinite(Number(last.close)) || now-Number(last.time) > Math.max(180,tf*3)) {
    return { direction:"none", reason:"Котировки устарели. Дождись обновления данных." };
  }
  let gaps=0;
  for(let i=1;i<bars.length;i++){
    const delta=Number(bars[i].time)-Number(bars[i-1].time);
    if(delta>tf*1.5) gaps += Math.max(1,Math.round(delta/tf)-1);
  }
  if(gaps>0) return { direction:"none", reason:"В истории свечей обнаружены пропуски. Сигнал отключён." };
  const closes=bars.map(x=>Number(x.close));
  if(closes.some(x=>!Number.isFinite(x))) return { direction:"none", reason:"Источник вернул некорректные цены." };
  const fast=ema(closes.slice(-30),9), slow=ema(closes.slice(-30),21);
  const momentum=closes.at(-1)-closes.at(-6);
  const strength=Math.abs(fast-slow)/Math.max(Math.abs(slow),1e-9);
  const oscillator=rsi(closes,14);
  let up=0,down=0;
  if(fast>slow) up+=2; else if(fast<slow) down+=2;
  if(momentum>0) up++; else if(momentum<0) down++;
  if(oscillator>=52 && oscillator<=68) up++;
  if(oscillator<=48 && oscillator>=32) down++;
  if(oscillator>75 || oscillator<25) return { direction:"none", reason:"Рынок в зоне сильного перекупленного/перепроданного движения — лучше пропустить." };
  if(Math.abs(up-down)<2 || strength<0.000015) return { direction:"none", reason:"Направление недостаточно выражено." };
  const direction=up>down?"up":"down";
  const score=Math.min(84, 56+Math.abs(up-down)*7+Math.min(10,strength*100000));
  return {
    direction, confidence:Math.round(score), symbol, timeframe:tf,
    expiry:tf, rsi:Number(oscillator.toFixed(1)),
    indicators:{emaFast:Number(fast.toPrecision(7)),emaSlow:Number(slow.toPrecision(7)),momentum:Number(momentum.toPrecision(7))},
    candleTime:Number(last.time), generatedAt:Date.now(),
    reason:direction==="up"?"Краткосрочный импульс и EMA указывают вверх.":"Краткосрочный импульс и EMA указывают вниз.",
    disclaimer:"Это аналитическая оценка, а не гарантия результата и не финансовая рекомендация."
  };
}

app.get("/health", (_req,res)=>res.json({ok:true,status:"ok",service:"SIGNAL AI",marketDataConfigured:Boolean(OTCHARTS_API_KEY)}));
app.get("/", (_req,res)=>res.sendFile(path.join(__dirname,"index.html")));
app.get("/api/status", authenticate, (_req,res)=>res.json({
  service:"SIGNAL AI", marketDataConfigured:Boolean(OTCHARTS_API_KEY),
  source:"OTCharts · read-only", supportedTimeframes:[60,300,900]
}));
app.get("/api/symbols", authenticate, async (req,res,next)=>{
  try {
    const venue=req.query.venue==="forex"?"forex":"otc";
    const key="symbols:"+venue, cached=cache.get(key);
    if(cached && Date.now()-cached.at<CACHE_MS) return res.json(cached.data);
    const data=await otcRequest("/v1/symbols",{venue});
    const symbols=(data.symbols||[]).filter(s=>ALLOWED_SYMBOLS.has(s.symbol));
    const result={venue,symbols};
    cache.set(key,{at:Date.now(),data:result});
    res.json(result);
  } catch(e){next(e);}
});
app.get("/api/signal", authenticate, async (req,res,next)=>{
  try {
    const symbol=String(req.query.symbol||"EURUSD_otc");
    const timeframe=Number(req.query.timeframe||60);
    const venue=symbol.endsWith("_otc")?"otc":"forex";
    if(!ALLOWED_SYMBOLS.has(symbol)) return res.status(400).json({error:"Неизвестный актив."});
    if(!TIMEFRAMES.has(timeframe)) return res.status(400).json({error:"Этот таймфрейм пока не поддерживается."});
    const key=`candles:${venue}:${symbol}:${timeframe}`, cached=cache.get(key);
    let data;
    if(cached && Date.now()-cached.at<CACHE_MS) data=cached.data;
    else {
      data=await otcRequest("/v1/candles",{venue,symbol,tf:timeframe,limit:80});
      cache.set(key,{at:Date.now(),data});
    }
    const symbolsKey="symbols:"+venue;
    let catalogue=cache.get(symbolsKey)?.data;
    if(!catalogue || Date.now()-cache.get(symbolsKey).at>60000){
      catalogue=await otcRequest("/v1/symbols",{venue});
      cache.set(symbolsKey,{at:Date.now(),data:catalogue});
    }
    const instrument=(catalogue.symbols||[]).find(x=>x.symbol===symbol);
    const result=analyze(data.candles,symbol,timeframe,instrument?.open!==false && Boolean(instrument));
    res.json({...result, symbolName:instrument?.name||symbol, isOpen:instrument?.open??null,
      payout:instrument?.payout??null, source:"OTCharts", candleCount:data.candles?.length||0,
      gaps:data.gaps||null});
  } catch(e){next(e);}
});

bot.start(ctx=>ctx.reply(
  "📡 SIGNAL AI\n\nАналитика рынка Pocket Option. Выбери актив и получи оценку направления UP / DOWN. Сигналы не гарантируют прибыль.",
  Markup.inlineKeyboard([[Markup.button.webApp("Открыть SIGNAL AI",MINI_APP_URL)]])
));
bot.command("app",ctx=>ctx.reply("Открыть SIGNAL AI:",Markup.inlineKeyboard([[Markup.button.webApp("Запустить приложение",MINI_APP_URL)]])));

app.use((err,_req,res,_next)=>{
  console.error("SIGNAL AI error:",err.message);
  res.status(err.status||500).json({error:err.status===429?"Лимит запросов к источнику исчерпан.":err.status===502?"Источник котировок временно недоступен.":err.status===503?err.message:"Внутренняя ошибка сервера."});
});
async function main(){
  app.listen(PORT,"0.0.0.0",()=>console.log(`SIGNAL AI listening on ${PORT}`));
  await bot.launch({dropPendingUpdates:true});
  console.log("SIGNAL AI Telegram bot started");
}
main().catch(err=>{console.error("Startup failed:",err);process.exit(1);});
process.once("SIGINT",()=>bot.stop("SIGINT"));
process.once("SIGTERM",()=>bot.stop("SIGTERM"));
