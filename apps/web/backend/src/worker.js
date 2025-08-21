// Cloudflare Worker (modules, JS)
// Proxy: /rpc (+WS), /x/pump/* (Pump.fun), /jup/* и /x/pump/jup/* (Jupiter)
// Лимиты: ENV RATE_MAX_RPS, RATE_MAX_CONCURRENCY

const JSON_CT = "application/json; charset=utf-8";

function allowedOrigin(req, env) {
  const origin = req.headers.get("Origin") || "";
  const cfg = (env.CORS_ORIGINS || "*").trim();
  if (cfg === "*" || !cfg) return "*";
  const list = cfg.split(",").map(s => s.trim()).filter(Boolean);
  return list.includes(origin) ? origin : (list[0] || "*");
}
function corsHeaders(req, env) {
  const allowOrigin = allowedOrigin(req, env);
  const reqHdr = req.headers.get("Access-Control-Request-Headers") || "*";
  return {
    "Access-Control-Allow-Origin": allowOrigin,
    "Access-Control-Allow-Methods": "GET,POST,OPTIONS",
    "Access-Control-Allow-Headers": reqHdr,
    "Access-Control-Allow-Credentials": "true",
    Vary: "Origin",
  };
}
function withCors(req, env, res) {
  const h = new Headers(res.headers);
  const extra = corsHeaders(req, env);
  for (const k in extra) h.set(k, extra[k]);
  return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}
function json(req, env, status, body) {
  return withCors(req, env, new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_CT } }));
}
function isAuthOk(req, env) {
  const required = (env.ACCESS_TOKEN || "").trim();
  if (!required) return true;
  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const x = req.headers.get("x-api-key") || "";
  return q === required || bearer === required || x === required;
}

function pickRpcHttp(env) {
  const url = (env.UPSTREAM_RPC_URL || env.UPSTREAM_ON_URL || env.UPSTREAM_QN_URL || "").trim();
  if (!url) throw new Error("UPSTREAM_RPC_URL is not set");
  return url;
}
function pickRpcWs(env) {
  return (env.UPSTREAM_RPC_WS || env.UPSTREAM_QN_WS || pickRpcHttp(env).replace(/^http/i, "ws")).trim();
}

let bucket = null, sem = null, limKey = "", booted = false;
const metrics = { started: Date.now(), inflight: 0, ok: 0, err: 0, lastSecTs: Math.floor(Date.now()/1000), lastSecCount: 0, latencies: [] };
function recordLatency(ms) { metrics.latencies.push(ms); if (metrics.latencies.length>100) metrics.latencies.shift(); }
function ensureLimits(env){ const maxC=Number(env.RATE_MAX_CONCURRENCY||16), maxR=Number(env.RATE_MAX_RPS||120), key=maxC+"|"+maxR; if(limKey!==key){ bucket=makeBucket(maxR); sem=makeSemaphore(maxC); limKey=key; }}
function bootTimersOnce(){ if(booted) return; booted=true; setInterval(()=>{ const sec=Math.floor(Date.now()/1000); if(sec!==metrics.lastSecTs){ metrics.lastSecTs=sec; metrics.lastSecCount=0; } },1000); }
function makeBucket(ratePerSec){ return { ratePerSec, capacity: ratePerSec, tokens: ratePerSec, last: Date.now(), refill(){ const now=Date.now(); const dt=(now-this.last)/1000; if(dt>0){ this.tokens=Math.min(this.capacity,this.tokens+dt*this.ratePerSec); this.last=now; } }, async take(){ for(;;){ this.refill(); if(this.tokens>=1){ this.tokens-=1; return; } await new Promise(r=>setTimeout(r,8)); } } }; }
function makeSemaphore(max){ return { max, inuse:0, q:[], async acquire(){ if(this.inuse< this.max){ this.inuse++; return; } await new Promise(res=>this.q.push(res)); this.inuse++; }, release(){ this.inuse=Math.max(0,this.inuse-1); const n=this.q.shift(); if(n) n(); }, getInUse(){return this.inuse;}, getQueueLen(){return this.q.length;} }; }

async function fetchWithRetry(u, init, env, opts){ const tries=Math.max(1,(opts&&opts.tries)||3); const timeoutMs=Math.max(1000,(opts&&opts.timeoutMs)||15000); let lastErr; for(let i=0;i<tries;i++){ const backoff=i===0?0:Math.min(5000,250*Math.pow(2,i-1))+Math.floor(Math.random()*200); if(backoff) await new Promise(r=>setTimeout(r,backoff)); await bucket.take(); await sem.acquire(); metrics.inflight++; const started=Date.now(); const ac=new AbortController(); const to=setTimeout(()=>ac.abort(),timeoutMs); try{ const r=await fetch(u,{...init,signal:ac.signal}); clearTimeout(to); recordLatency(Date.now()-started); metrics.lastSecCount++; if(r.ok){ metrics.ok++; return r; } if(r.status===429||r.status>=500){ lastErr=new Error(r.status+" "+r.statusText); continue; } return r; }catch(e){ lastErr=e; }finally{ metrics.inflight=Math.max(0,metrics.inflight-1); sem.release(); } } metrics.err++; throw lastErr||new Error("upstream failed"); }

const coalesce = { getAccountInfo:new Map(), getBalance:new Map(), timer:null, schedule(env,upstream){ if(this.timer) return; this.timer=setTimeout(async()=>{ const m1=this.getAccountInfo; this.getAccountInfo=new Map(); const m2=this.getBalance; this.getBalance=new Map(); this.timer=null; const flush=async(entries,kind)=>{ for(const [,list] of entries){ try{ const pubkeys=list.map(p=>p.body.params?.[0]); const options=list[0]?.body.params?.[1]||{}; const batch={ jsonrpc:"2.0", id:1, method:"getMultipleAccounts", params:[pubkeys,options] }; const r=await fetchWithRetry(pickRpcHttp(env),{ method:"POST", headers:{"content-type":"application/json"}, body:JSON.stringify(batch)},env,{tries:3,timeoutMs:15000}); const j=await r.json().catch(()=>null); const results=(j?.result?.value||[]); for(let i=0;i<list.length;i++){ const it=list[i]; const value=results[i]??null; const body= kind==="getBalance"? { jsonrpc:"2.0", id:it.body.id, result:{ value:Number(value?.lamports??0) } } : { jsonrpc:"2.0", id:it.body.id, result:value }; it.resolve(new Response(JSON.stringify(body),{status:200,headers:{"content-type":JSON_CT}})); } }catch(e){ for(const it of list) it.reject(e); } } }; await Promise.all([flush(m1,"getAccountInfo"), flush(m2,"getBalance")]); },12); } };

async function handleRpcHttp(req, env){ if(!isAuthOk(req,env)) return json(req,env,401,{error:"UNAUTHORIZED"}); const upstream=pickRpcHttp(env); const hdr=new Headers({"content-type":"application/json"}); if(env.QN_TOKEN) hdr.set("x-api-key", env.QN_TOKEN); const raw=await req.text(); let parsed=null; try{ parsed=JSON.parse(raw);}catch{} if(Array.isArray(parsed)){ const r=await fetchWithRetry(upstream,{method:"POST",headers:hdr,body:raw},env,{tries:3,timeoutMs:20000}); return withCors(req,env,r); } const tryCoalesce=(call)=>{ if(!call||typeof call!=="object") return null; const method=call.method; if(method!=="getAccountInfo"&&method!=="getBalance") return null; const params=Array.isArray(call.params)?call.params:[]; const key=[String(params?.[1]?.commitment||"processed"),String(params?.[1]?.encoding||"base64"),method].join("|"); const map=method==="getAccountInfo"?coalesce.getAccountInfo:coalesce.getBalance; return new Promise((resolve,reject)=>{ const arr=map.get(key)||[]; arr.push({resolve,reject,body:call}); map.set(key,arr); coalesce.schedule(env,upstream); }); };
  const maybe=tryCoalesce(parsed); if(maybe){ const r=await maybe; return withCors(req,env,r); }
  const r=await fetchWithRetry(upstream,{method:"POST",headers:hdr,body:raw},env,{tries:3,timeoutMs:20000}); return withCors(req,env,r); }

export default {
  async fetch(req, env, ctx){
    ensureLimits(env); bootTimersOnce();
    const url=new URL(req.url);

    if(req.method==="OPTIONS") return new Response(null,{headers:corsHeaders(req,env)});

    if(req.headers.get("upgrade")?.toLowerCase()==="websocket" && url.pathname.startsWith("/rpc")){
      if(!isAuthOk(req,env)) return new Response("Unauthorized",{status:401});
      const upWs=new URL(pickRpcWs(env));
      const wsHdr=new Headers(req.headers); if(env.QN_TOKEN) wsHdr.set("x-api-key", env.QN_TOKEN);
      return fetch(upWs.toString(), new Request(req,{headers:wsHdr}));
    }

    if(req.method==="GET" && (url.pathname==="/rpc/health"||url.pathname==="/__health")){
      return withCors(req,env,new Response("ok",{status:200}));
    }

    if(req.method==="POST" && url.pathname==="/rpc"){
      return handleRpcHttp(req,env);
    }

    // Jupiter (до общего /x/pump)
    if(url.pathname.startsWith("/jup/") || url.pathname.startsWith("/x/pump/jup/")){
      const JUP_BASE="https://quote-api.jup.ag";
      const rel=url.pathname.replace(/^\/x\/pump\/jup/,"/jup");
      const after=rel.replace(/^\/jup/,"");
      const upstreamPath=after.startsWith("/v")?after:`/v6${after||""}`;
      const target=new URL(upstreamPath+url.search,JUP_BASE);
      const isPost=req.method==="POST"; const raw=isPost?await req.text():undefined;
      const r=await fetchWithRetry(target.toString(),{ method:isPost?"POST":"GET", headers:{ accept:"application/json", ...(isPost?{"content-type":"application/json"}:{}) }, body:raw }, env,{tries:3,timeoutMs:15000});
      const ct=r.headers.get("content-type")||"";
      if(!ct.includes("application/json") && r.status<400){ const txt=await r.text().catch(()=>""); return json(req,env,502,{error:"JUP_NON_JSON",status:r.status,body:txt.slice(0,120)}); }
      return withCors(req,env,r);
    }

    if(url.pathname.startsWith("/x/pump")){
      const targetPath=url.pathname.replace(/^\/x\/pump/,"")||"/";
      const base=(env.PUMP_BASE||"https://pumpportal.fun").replace(/\/+$/,'');
      const targetUrl=new URL(base+targetPath); targetUrl.search=url.search;
      const hdr=new Headers(req.headers);
      hdr.delete("host"); hdr.delete("cf-connecting-ip"); hdr.delete("x-forwarded-for"); hdr.delete("x-real-ip");
      if(env.PUMP_API_KEY) hdr.set("x-api-key", env.PUMP_API_KEY);
      const r=await fetchWithRetry(targetUrl.toString(),{ method:req.method, headers:hdr, body:req.body }, env,{tries:3,timeoutMs:20000});
      return withCors(req,env,r);
    }

    if(url.pathname==="/" && req.method==="GET"){
      const body=`rpc-proxy worker\n- POST /rpc        -> JSON-RPC proxy\n- WS   /rpc        -> WebSocket proxy\n- GET  /rpc/health -> health check\n- *    /x/pump/*   -> proxy to PUMP_BASE\n- *    /jup/*      -> proxy to https://quote-api.jup.ag (v6)\n- GET  /__metrics  -> in-memory metrics\n`;
      return withCors(req,env,new Response(body,{status:200,headers:{"content-type":"text/plain; charset=utf-8"}}));
    }

    if(url.pathname==="/__metrics" && req.method==="GET"){
      const avg=metrics.latencies.length?Math.round(metrics.latencies.reduce((a,b)=>a+b,0)/metrics.latencies.length):0;
      return withCors(req,env,new Response(JSON.stringify({
        uptimeSec: Math.round((Date.now()-metrics.started)/1000),
        inflight: metrics.inflight,
        queued: sem.getQueueLen(),
        ok: metrics.ok,
        err: metrics.err,
        rpsWindowSec: 1,
        rps: metrics.lastSecCount,
        avgLatencyMs: avg,
        concurrencyInUse: sem.getInUse(),
      }),{status:200,headers:{"content-type":JSON_CT}}));
    }

    return json(req,env,404,{error:"NOT_FOUND"});
  }
}

