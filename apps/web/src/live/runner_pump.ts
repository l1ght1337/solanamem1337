// apps/web/src/live/runner_pump.ts
import {
  Connection,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
  PublicKey,
} from "@solana/web3.js";
import { TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID } from "@solana/spl-token";
import { getSPLBalance } from "../utils/solana";
import { scheduleFetch } from "../utils/network";
import { getJupiterQuote, WSOL } from "../utils/jupiter";
import { safeMultiply, safeAdd } from "../utils/number";
import { confirmSigHttp } from "../utils/confirm";

/* ───────────────────────────── Types ───────────────────────────── */
type BotStrategy = "trend" | "revert" | "scalper";
type InternalStrategy = BotStrategy | "momentum" | "range" | "maker";

type LiveBot = {
  id: string;
  name: string;
  strategy: BotStrategy;
  budgetSol: number;
  speedMs: number;
  running: boolean;
  aiEnabled: boolean;
  keyId: string;
  pubkey: string;
  solBalance: number;
  tokenBalance: number;
  posToken: number;
  avgSol: number;
  realized: number;
  unrealized: number;
  fills: number;
  last?: string;
  lastError?: string;
};

type RunCtx = {
  mint: string;
  slippageBps: () => number;
  twap?: { slices: number; gapMs: number } | null;

  price: () => number;
  change1m: () => number;
  changeFast?: (secs?: number) => number;

  keypair: () => Keypair;
  tokenDecimals: () => number;
  tradeSize: () => number;

  isAiPaused?: () => boolean;

  setLightRefresh?: () => void;
  shouldLightRefresh?: (ms: number) => boolean;
  abortSignal?: AbortSignal;

  onLog: (l: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
  afterTrade?: () => void;

  getRisk?: () => {
    maxImpact: number;
    maxDrawdown: number;
    reserveSol: number;
    maxNotionalPerMin: number;
    maxBuysPerMin: number;
    maxSellsPerMin: number;
    lossThrPct: number;
    lossWindowMs: number;
    lossCooldownMs: number;
    maxBuySliceSol: number;
    maxSellSliceTokPct: number;
    minSliceGapMs: number;
    maxSliceGapMs: number;
    noLossFloorBps?: number; // 0…30 = 0…0.3%
    maxRoundtripLoss?: number; // 0.0…0.2 (доля), дефолт ниже
  };
};

/* ─────────────────────── Net bases & utilities ─────────────────────── */
const API_BASE = ((import.meta as any).env?.VITE_API_BASE || "").replace(/\/+$/, "");
const ALT_PUMP = ((import.meta as any).env?.VITE_PUMP_API || "").replace(/\/+$/, "");
const PUMP_BASES = [API_BASE ? `${API_BASE}/x/pump` : "", ALT_PUMP, "https://pumpportal.fun"].filter(Boolean);

const PF_BASE_SOL = Math.max(0.000006, Number(((import.meta as any).env?.VITE_PRIORITY_FEE_BASE) ?? 0.000008));
const PF_MAX_SOL  = Math.max(PF_BASE_SOL, Number(((import.meta as any).env?.VITE_PRIORITY_FEE_MAX)  ?? 0.00012));

type Job<T> = () => Promise<T>;
function makeQueue(concurrency = 8, baseGapMs = 60) {
  const q: Array<{ job: Job<any>; res: (v: any) => void; rej: (e: any) => void }> = [];
  let running = 0;
  async function runNext() {
    if (running >= concurrency) return;
    const it = q.shift(); if (!it) return;
    running++;
    try {
      const jitter = baseGapMs + Math.floor(Math.random() * baseGapMs);
      const out = await it.job();
      await new Promise(r => setTimeout(r, jitter));
      it.res(out);
    } catch (e) { it.rej(e); }
    finally { running--; runNext(); }
  }
  return <T>(job: Job<T>) => new Promise<T>((res, rej) => { q.push({ job, res, rej }); runNext(); });
}
const enqueueTradeBuild =
  (window as any).__tradeQ || ((window as any).__tradeQ = makeQueue());

let stickyBaseIdx = -1;
async function fetchFirstOk(path: string, init: RequestInit = {}, retries = 2) {
  const order = [...PUMP_BASES.keys()];
  if (stickyBaseIdx >= 0) {
    const i = order.indexOf(stickyBaseIdx);
    if (i > 0) { order.splice(i, 1); order.unshift(stickyBaseIdx); }
  }
  let lastErr: any;
  for (const idx of order) {
    const base = PUMP_BASES[idx];
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let a = 0; a <= retries; a++) {
      const backoff = a === 0 ? 0 : 250 * a + Math.floor(Math.random() * 250);
      if (backoff) await new Promise(r => setTimeout(r, backoff));
      try {
        const r = await scheduleFetch(url, { ...(init as any), timeoutMs: 20_000, tries: 1 }, "pump");
        if (r.ok) { stickyBaseIdx = idx; return r; }
        if (r.status === 429 || r.status >= 500) { lastErr = new Error(`${r.status} ${r.statusText}`); continue; }
        const txt = await r.text().catch(() => "");
        throw new Error(`${r.status} ${r.statusText}${txt ? `: ${txt}` : ""}`);
      } catch (e) { lastErr = e; }
    }
  }
  stickyBaseIdx = -1;
  throw lastErr || new Error("All pump endpoints failed");
}

async function buildTradeTxPump(payload: Record<string, any>): Promise<VersionedTransaction> {
  return enqueueTradeBuild(async () => {
    const tries: Array<{ path: string; bin: boolean }> = [
      { path: "/api/trade-local", bin: true },
      { path: "/api/trade",       bin: false },
    ];
    let lastErr: any;
    for (const t of tries) {
      try {
        const r = await fetchFirstOk(t.path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
        const ct = r.headers.get("content-type") || "";
        if (t.bin && /octet-stream/.test(ct)) {
          const raw = new Uint8Array(await r.arrayBuffer());
          return VersionedTransaction.deserialize(raw);
        }
        const j = await r.json().catch(() => ({} as any));
        const b64 = j?.serializedTransaction || j?.tx || j?.transaction || j?.vtx;
        if (!b64) throw new Error("no serialized transaction in response");
        const raw = Uint8Array.from(atob(String(b64)), c => c.charCodeAt(0));
        return VersionedTransaction.deserialize(raw);
      } catch (e) { lastErr = e; }
    }
    throw lastErr || new Error("trade build failed");
  });
}

/* ─────────────────── Helpers / risk / math ─────────────────── */
const FEE_EST_SOL  = 0.00002; // ~20k lamports
const MIN_KEEP_SOL = 0.0006;

let TARGET_ALLOC = 0.70;
let MAX_ALLOC    = 0.85;
let MIN_ALLOC    = 0.60;

const MAX_TOTAL_DRAWDOWN = 0.30;
const MAX_SINGLE_TRADE_IMPACT = 0.015;
const DEFAULT_RT_LOSS  = 0.025; // ← дефолтный порог 2.5% (сценарий может переопределить)

const MIN_SLP_BPS = 30;
const MAX_SLP_BPS = 120;

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

function roundTok(tokens: number, decimals: number) {
  const p = Math.pow(10, Math.min(6, decimals));
  return Math.max(0, Math.floor(tokens * p) / p);
}

function capsForStrategy(s: InternalStrategy) {
  switch (s) {
    case "trend":    return { buySlice: 0.0015, sellPct: 0.10, stepMulMin: 1.0, stepMulMax: 1.0 };
    case "revert":   return { buySlice: 0.0012, sellPct: 0.14, stepMulMin: 0.8, stepMulMax: 0.9 };
    case "scalper":  return { buySlice: 0.0009, sellPct: 0.08, stepMulMin: 0.5, stepMulMax: 0.6 };
    case "momentum": return { buySlice: 0.0018, sellPct: 0.12, stepMulMin: 1.1, stepMulMax: 1.3 };
    case "range":    return { buySlice: 0.0010, sellPct: 0.10, stepMulMin: 0.7, stepMulMax: 0.9 };
    case "maker":    return { buySlice: 0.0006, sellPct: 0.06, stepMulMin: 0.4, stepMulMax: 0.5 };
    default:         return { buySlice: 0.0012, sellPct: 0.10, stepMulMin: 1.0, stepMulMax: 1.0 };
  }
}

/* ───────────────────────────── Runner ───────────────────────────── */
export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;
  let cooldownUntil = 0;

  let failStreak = 0;
  let nextRetryAt = 0;
  let lastWarnTs = 0;

  let baselineValue = 0;

  let buysInRow = 0;
  let sellsInRow = 0;
  let lastBuyTs = 0;
  let lastSellTs = 0;
  let trailHighPrice = 0;

  let deferredSell: { dueAt: number; amountTok: number } | null = null;
  const priceHist: number[] = [];

  const log  = (lvl: "info" | "ok" | "warn" | "err", s: string) => ctx.onLog(lvl, `[${bot.name}] ${s}`);
  const warn = (s: string) => { const n = Date.now(); if (n - lastWarnTs > 1500) { lastWarnTs = n; log("warn", s); } };

  function pushUpdate(p: Partial<LiveBot>) {
    ctx.onUpdate({ id: bot.id, ...p } as any);
  }

  const alloc = (priceNow: number) => {
    const tokVal = bot.posToken * priceNow;
    const total  = Math.max(1e-9, tokVal + bot.solBalance);
    return { tokVal, total, a: tokVal / total };
  };

  let minWindowStart = Date.now();
  let buysThisMin = 0;
  let sellsThisMin = 0;
  let notionalThisMin = 0;

  let lastBuyAtPrice: number | null = null;
  let lastBuyAtTs = 0;
  let lossCooldownUntil = 0;

  function scheduleSell(amountTok: number, minMs: number, maxMs: number) {
    const now = Date.now();
    const delay = Math.max(0, minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)));
    deferredSell = { dueAt: now + delay, amountTok: Math.max(0, amountTok) };
  }
  async function getParsedTokenBalanceAny(
    connection: Connection,
    owner58: string,
    mint58: string,
    decimals: number
  ): Promise<number> {
    try {
      const owner = new PublicKey(owner58);
      const mintStr = mint58;

      const [rClassic, r22] = await Promise.allSettled([
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID }, "confirmed"),
        connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_2022_PROGRAM_ID }, "confirmed"),
      ]);

      const collected: any[] = [];
      const pick = (res: any) => {
        const arr = (res?.value ?? []) as any[];
        for (const it of arr) {
          try {
            if (it?.account?.data?.parsed?.info?.mint === mintStr) collected.push(it);
          } catch {}
        }
      };
      if (rClassic.status === "fulfilled") pick(rClassic.value);
      if (r22.status === "fulfilled") pick(r22.value);

      let sum = 0n;
      for (const it of collected) {
        try { sum += BigInt(it.account.data.parsed.info.tokenAmount.amount); } catch {}
      }
      return Number(sum) / Math.pow(10, decimals);
    } catch { return 0; }
  }

  async function refreshOnChainBalances() {
  try {
     const owner = ctx.keypair().publicKey;
     const lam = await connection.getBalance(owner, { commitment: "confirmed" as any });
     const sol = lam / LAMPORTS_PER_SOL;

      const decimals = Math.max(0, Number(ctx.tokenDecimals?.() ?? 9));
      let tok = 0;

    // Быстрый путь (ваш util)
      try {
        const raw = await getSPLBalance(connection, owner.toBase58(), ctx.mint);
        const n = Number(raw as any);
        if (Number.isFinite(n) && n > 0) tok = n / Math.pow(10, decimals);
      } catch {}

    // ⬇️ Надёжный fallback для Token‑2022 / редких RPC
      if (!(tok > 0)) {
        try {
          tok = await getParsedTokenBalanceAny(
            connection,
            owner.toBase58(),
            ctx.mint,
            decimals
          );
        } catch {}
      }

      bot.solBalance = sol;
      bot.tokenBalance = tok;
      pushUpdate({ solBalance: sol, tokenBalance: tok });
    } catch {}
  }


  async function trade(side: "buy" | "sell", sizeSol: number, opts?: { sellTokens?: number }) {
    let risk = {
      maxImpact: 0.010,
      maxDrawdown: 0.12,
      reserveSol: 0.0060,
      maxNotionalPerMin: 0.0035,
      maxBuysPerMin: 3,
      maxSellsPerMin: 6,
      lossThrPct: 0.004,
      lossWindowMs: 30000,
      lossCooldownMs: 120000,
      maxBuySliceSol: 0.00055,
      maxSellSliceTokPct: 0.06,
      minSliceGapMs: 500,
      maxSliceGapMs: 1400,
      noLossFloorBps: 0,
      maxRoundtripLoss: DEFAULT_RT_LOSS,
    } as any;
    try { const r = ctx.getRisk?.(); if (r) risk = { ...risk, ...r }; } catch {}

    try {
      const allocUI = (ctx as any).getAlloc?.();
      if (allocUI && typeof allocUI.target === "number") {
        TARGET_ALLOC = Math.min(0.95, Math.max(0.05, allocUI.target));
        MIN_ALLOC    = Math.min(TARGET_ALLOC, Math.max(0.05, allocUI.min ?? 0.6));
        MAX_ALLOC    = Math.max(TARGET_ALLOC, Math.min(0.98, allocUI.max ?? 0.85));
      }
    } catch {}

    let step = { minSol: 0.0002, maxSol: 0.0008, slicesMax: 4, jitterPct: 0.25 };
    try { const s = (ctx as any).getTradeStep?.(); if (s) step = s; } catch {}
    const pickStep = () => {
      const base = step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
      const jitter = 1 + (Math.random() * 2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
      return Math.max(0.00005, +(base * jitter).toFixed(6));
    };

    const kp        = ctx.keypair();
    const decimals  = ctx.tokenDecimals();
    const priceNow  = Math.max(1e-12, ctx.price());
    const noLossMul = 1 + Math.max(0, Number(risk.noLossFloorBps) || 0) / 10_000;

    let amountTok: number | undefined =
      side === "sell" && opts?.sellTokens ? roundTok(opts.sellTokens, decimals) : undefined;

    // Коридор
    try {
      const { a, total } = alloc(priceNow);
      const EPS = 0.002;

      if (side === "buy" && a >= MAX_ALLOC - EPS) {
        log("info", "skip BUY: at/above maxAlloc");
        return;
      }
      if (side === "sell" && a <= MIN_ALLOC + EPS) {
        if (!opts?.sellTokens) { log("info", "skip SELL: at/below minAlloc"); return; }
      }

      if (side === "buy" && sizeSol > 0) {
        const currTokVal = bot.posToken * priceNow;
        const maxBuyVal  = Math.max(0, (Math.max(0, MAX_ALLOC - EPS)) * total - currTokVal);
        const original   = sizeSol;
        const clamped    = Math.min(sizeSol, maxBuyVal);
        // 🛠️ снимаем прежний порог 0.00012 — оставляем только нулевой
        if (clamped <= 0) { log("info", "skip BUY: corridor"); return; }
        sizeSol = +clamped.toFixed(6);
        if (sizeSol < original - 1e-9) log("info", `clamped buy ${original.toFixed(6)}→${sizeSol.toFixed(6)}`);
      } else if (side === "sell") {
        const currTokVal     = bot.posToken * priceNow;
        const minTokValAfter = Math.max(0, (Math.min(0.98, MIN_ALLOC + EPS)) * total);
        const maxSellTok     = Math.max(0, (currTokVal - minTokValAfter) / Math.max(1e-12, priceNow));
        const applyClamp = (src: number) => {
          const cl = Math.min(src, maxSellTok);
          return cl > 0 ? roundTok(cl, decimals) : 0;
        };
        if (opts?.sellTokens) {
          const originalTok = opts.sellTokens;
          const newAmt = applyClamp(originalTok);
          if (newAmt <= 0) { log("info", "skip SELL: corridor"); return; }
          (opts as any).sellTokens = newAmt;
          amountTok = newAmt;
          if (newAmt < originalTok - 1e-12) log("info", `clamped sell ${roundTok(originalTok,decimals)}→${roundTok(newAmt,decimals)}`);
        } else {
          const base = amountTok ?? bot.posToken;
          const capped = applyClamp(base);
          if (capped <= 0) { log("info", "skip SELL: corridor"); return; }
          amountTok = capped;
        }
      }
    } catch {}

    if (side === "buy"  && sizeSol <= 0) { log("info", "skip BUY: corridor"); return; }
    if (side === "sell" && (amountTok ?? bot.posToken) <= 0) { log("info", "skip SELL: corridor"); return; }

    // Резерв SOL
    if (side === "buy") {
      const reserve = Math.max(MIN_KEEP_SOL, Number(risk.reserveSol) || 0);
      const stepCfg = (ctx as any).getTradeStep?.() ?? { minSol: 0.0002 };
      const need    = reserve + Math.max(0.00005, Number(stepCfg.minSol) || 0.0002);
      if ((bot.solBalance ?? 0) < need) {
        log("info", "skip BUY: low SOL; scheduling tiny SELL for fees");
        if (bot.posToken > 0) {
          const wantSol = Math.min(0.0015, need - (bot.solBalance ?? 0));
          const sellTok = roundTok(Math.max(0, Math.min(bot.posToken * (Number(risk.maxSellSliceTokPct) || 0.035), wantSol / Math.max(1e-12, priceNow))), decimals);
          if (sellTok > 0) {
            const gmin = Math.max(120, Number(risk.minSliceGapMs) || 600);
            const gmax = Math.max(gmin + 50, Number(risk.maxSliceGapMs) || 1800);
            scheduleSell(sellTok, gmin, gmax);
          }
        }
        return;
      }
    }

    // Минутные лимиты — клампим headroom вместо «skip» целиком
    const nowTs = Date.now();
    if (nowTs - minWindowStart >= 60_000) { minWindowStart = nowTs; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
    if (side === "buy") {
      if (nowTs < lossCooldownUntil) { log("info", "skip BUY: loss cooldown"); return; }
      if (buysThisMin >= risk.maxBuysPerMin) { log("info", "skip BUY: minute limits (count)"); return; }
      const maxPerMin = Number(risk.maxNotionalPerMin);
      if (isFinite(maxPerMin)) {
        const headroom = Math.max(0, maxPerMin - notionalThisMin);
        if (headroom <= 0.000049) { log("info", "skip BUY: minute headroom 0"); return; }
        if (sizeSol > headroom) {
          log("info", `clamped by minute notional ${sizeSol.toFixed(6)}→${headroom.toFixed(6)}`);
          sizeSol = +headroom.toFixed(6);
        }
      }
    } else {
      if (sellsThisMin >= risk.maxSellsPerMin) { log("info", "skip SELL: minute limits (count)"); return; }
    }

    // адаптивный слиппедж и приоритет
    const short = Math.abs(ctx.changeFast?.(12) || 0);
    const one   = Math.abs((ctx.change1m?.() as any) || 0);
    const volScore = Math.max(short, one);
    let lo = MIN_SLP_BPS, hi = MAX_SLP_BPS;
    if (volScore < 0.002) { lo = 30; hi = 60; }
    else if (volScore < 0.006) { lo = 50; hi = 90; }
    else { lo = 80; hi = 120; }
    const rawBps  = Number((ctx as any).slippageBps?.() ?? 50);
    const usedBps = Math.round(Math.max(lo, Math.min(hi, rawBps)));
    const multByFail = failStreak >= 4 ? 4 : (failStreak >= 2 ? 2 : 1);
    let priorityFeeSol = PF_BASE_SOL * multByFail * (volScore > 0.006 ? 1.35 : (volScore > 0.003 ? 1.15 : 1.0));
    priorityFeeSol = Math.min(PF_MAX_SOL, +priorityFeeSol.toFixed(6));

    const payloadBase = {
      publicKey: kp.publicKey.toBase58(),
      mint: ctx.mint,
      slippage: usedBps / 100,
      priorityFee: priorityFeeSol,
      pool: "auto",
    };

    // BUY sanity‑check по размеру будущего среза, а не всей сделки
    const quoteFn = (ctx as any).getJupiterQuote || getJupiterQuote;
    if (side === "buy") {
      try {
        const samplePerSlice = Math.min(
          (sizeSol || 0.0003),
          Math.max(0.00008, Number(risk.maxBuySliceSol) || 0.00055)
        );
        const pay = Math.round(samplePerSlice * 1e9);
        const q   = await quoteFn({ inputMint: WSOL, outputMint: ctx.mint, amount: pay });
        const fairOut = (pay / 1e9) / priceNow;
        const out     = Number(q?.outAmount || 0) / Math.pow(10, decimals);
        if (!isFinite(out) || out <= 0) { warn("skip BUY: illiquid route"); return; }
        const maxImpact = Math.max(0, Math.min(0.2, Number(risk.maxImpact ?? MAX_SINGLE_TRADE_IMPACT)));
        const impact = fairOut > 0 ? Math.max(0, 1 - out / fairOut) : 1;
        if (fairOut > 0 && impact > maxImpact) { warn(`skip BUY: impact ${(impact*100).toFixed(1)}% > ${(maxImpact*100).toFixed(1)}%`); return; }

        const RT_SAMPLE = Math.min(1, Math.max(0, Number(((import.meta as any).env?.VITE_RT_SAMPLE) ?? 0.33)));
        if (out > 0 && Math.random() < RT_SAMPLE) {
          try {
            const backRaw = Math.max(1, Math.round(out * Math.pow(10, decimals)));
            const qb = await quoteFn({ inputMint: ctx.mint, outputMint: WSOL, amount: backRaw });
            const backSol = Number(qb?.outAmount || 0) / 1e9;
            const lossPct = Math.max(0, 1 - backSol / Math.max(1e-12, (pay / 1e9)));
            const maxRt   = Math.max(0, Number(risk.maxRoundtripLoss ?? DEFAULT_RT_LOSS));
            if (isFinite(lossPct) && lossPct > maxRt) { warn(`skip BUY: roundtrip ${(lossPct*100).toFixed(1)}% > ${(maxRt*100).toFixed(1)}%`); return; }
          } catch {}
        }
      } catch {}
    }

    const caps = capsForStrategy(bot.strategy as InternalStrategy);
    let remainingSol = side === "buy"  ? (sizeSol || pickStep()) : 0;
    let remainingTok = side === "sell" ? (amountTok ?? bot.posToken) : 0;
    let maxBuyPerSlice = Math.max(0.00005, Math.min((risk.maxBuySliceSol || 0.0018), caps.buySlice));
    const maxSellPct   = Math.min(0.5, Math.max(0.02, Math.min((risk.maxSellSliceTokPct || 0.12), caps.sellPct)));
    const maxSellPerSlice = side === "sell" ? roundTok((bot.posToken || 0) * maxSellPct, decimals) : 0;

    let slices = Math.max(1, Math.min(step.slicesMax, Math.round(1 + Math.random() * (step.slicesMax - 1))));
    if (side === "sell" && maxSellPerSlice > 0) {
      const need = Math.ceil(remainingTok / Math.max(1e-12, maxSellPerSlice));
      slices = Math.min(step.slicesMax, Math.max(slices, need));
    }

    let localPosToken = bot.posToken;
    let localSol      = bot.solBalance;

    let executedSol = 0;
    let executedTok = 0;
    let executedSlices = 0;

    const EPS = 0.0015;

    for (let si = 0; si < slices; si++) {
      let pl: any;
      if (side === "buy") {
        const pnow = Math.max(1e-12, ctx.price());
        const currTokVal   = localPosToken * pnow;
        const totalLocal   = Math.max(1e-9, currTokVal + localSol);
        const maxBuyValLoc = Math.max(0, (Math.max(0, MAX_ALLOC - EPS)) * totalLocal - currTokVal);
        if (maxBuyValLoc <= 0) { log("info", `stop BUY slicing: would breach maxAlloc ${(MAX_ALLOC*100).toFixed(1)}%`); break; }

        let pay = Math.min(maxBuyPerSlice, remainingSol, maxBuyValLoc);
        if (pay <= 0.000049) break;
        pl = { ...payloadBase, action: "buy", denominatedInSol: "true", amount: +pay.toFixed(6) };
        remainingSol = Math.max(0, +(remainingSol - pay).toFixed(6));

        const volScoreNow = Math.max(Math.abs(ctx.changeFast?.(8) || 0), Math.abs(ctx.change1m?.() || 0));
        if (volScoreNow > 0.006) maxBuyPerSlice = Math.max(0.00005, +(maxBuyPerSlice * 0.75).toFixed(6));

        const now2 = Date.now();
        if (now2 - minWindowStart >= 60_000) { minWindowStart = now2; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
        if (buysThisMin >= risk.maxBuysPerMin) { log("info", "stop BUY slicing: minute count"); break; }
        if (notionalThisMin + pl.amount > (Number(risk.maxNotionalPerMin) || 0)) { log("info", "stop BUY slicing: minute notional"); break; }
      } else {
        const pnow = Math.max(1e-12, ctx.price());
        const currTokVal   = localPosToken * pnow;
        const totalLocal   = Math.max(1e-9, currTokVal + localSol);
        const minTokValAf  = Math.max(0, (Math.min(0.98, MIN_ALLOC + EPS)) * totalLocal);
        const maxSellTokLoc= Math.max(0, (currTokVal - minTokValAf) / Math.max(1e-12, pnow));
        if (maxSellTokLoc <= 0) { log("info", `stop SELL slicing: would breach minAlloc ${(MIN_ALLOC*100).toFixed(1)}%`); break; }

        let qty = (() => {
          const cap = maxSellPerSlice > 0
            ? Math.min(maxSellPerSlice, remainingTok, maxSellTokLoc)
            : Math.min(remainingTok / Math.max(1, (slices - si)), maxSellTokLoc);
          return roundTok(Math.max(0, cap), decimals);
        })();

        if (qty <= 0) break;

        if (!opts?.sellTokens && bot.avgSol > 0 && risk.noLossFloorBps && risk.noLossFloorBps > 0) {
          if (pnow < bot.avgSol * noLossMul) {
            const gmin = Math.max(120, Number(risk.minSliceGapMs) || 600);
            const gmax = Math.max(gmin + 50, Number(risk.maxSliceGapMs) || 1800);
            scheduleSell(qty, gmin, gmax);
            log("info", `skip SELL no-loss floor (${((noLossMul-1)*100).toFixed(2)}%), deferred`);
            break;
          }
        }

        try {
          const rawQ   = Math.max(1, Math.round(qty * Math.pow(10, decimals)));
          const q      = await quoteFn({ inputMint: ctx.mint, outputMint: WSOL, amount: rawQ });
          const outSol = Number(q?.outAmount || 0) / 1e9;
          if (!isFinite(outSol) || outSol <= 0) { warn("skip SELL: illiquid route"); break; }
          const fair   = qty * pnow;
          const thr    = Math.max(0, Math.min(0.2, Number(risk.maxImpact ?? MAX_SINGLE_TRADE_IMPACT)));
          let impact   = fair > 0 ? Math.max(0, 1 - outSol / fair) : 0;

          if (impact > thr) {
            const sh1 = roundTok(qty * 0.55, decimals);
            if (sh1 > 0 && sh1 < qty) {
              qty = sh1;
              const raw2 = Math.max(1, Math.round(qty * Math.pow(10, decimals)));
              const q2   = await quoteFn({ inputMint: ctx.mint, outputMint: WSOL, amount: raw2 });
              const out2 = Number(q2?.outAmount || 0) / 1e9;
              const imp2 = qty * pnow > 0 ? Math.max(0, 1 - out2 / (qty * pnow)) : 0;
              if (imp2 > thr) { warn(`skip SELL: impact ${(imp2*100).toFixed(1)}% > ${(thr*100).toFixed(1)}%`); break; }
            } else { warn(`skip SELL: impact ${(impact*100).toFixed(1)}% > ${(thr*100).toFixed(1)}%`); break; }
          }
        } catch { warn("skip SELL: quote failed"); break; }

        const now2 = Date.now();
        if (now2 - minWindowStart >= 60_000) { minWindowStart = now2; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
        if (sellsThisMin >= (Number(risk.maxSellsPerMin) || 0)) { log("info", "stop SELL slicing: minute count"); break; }

        pl = { ...payloadBase, action: "sell", denominatedInSol: "false", amount: qty };
        remainingTok = Math.max(0, remainingTok - qty);
      }

      const vtx = await buildTradeTxPump(pl);
      vtx.sign([kp]);
      const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 4 });
      await confirmSigHttp(connection, sig);

      executedSlices++;
      if (pl.action === "buy") {
        executedSol += pl.amount;
        localPosToken += pl.amount / Math.max(1e-12, ctx.price());
        localSol      = Math.max(0, localSol - pl.amount - FEE_EST_SOL);
        buysThisMin++;
        notionalThisMin = +(notionalThisMin + pl.amount).toFixed(6);
      } else {
        executedTok += pl.amount;
        localPosToken = Math.max(0, localPosToken - pl.amount);
        localSol     += Math.max(0, pl.amount * Math.max(1e-12, ctx.price()) - FEE_EST_SOL);
        sellsThisMin++;
      }

      if (si < slices - 1 && ((pl.action === "buy" ? remainingSol > 0 : remainingTok > 0))) {
        const gmin = Math.max(120, (risk.minSliceGapMs || 600));
        const gmax = Math.max(gmin + 50, (risk.maxSliceGapMs || 1800));
        const gap  = gmin + Math.floor(Math.random() * (gmax - gmin));
        await sleep(gap);
      }
    }

    if (executedSlices === 0) throw new Error("no slices executed");

    failStreak = 0;
    nextRetryAt = 0;

    const pnow = Math.max(1e-12, ctx.price());
    if (side === "buy") {
      const qty   = executedSol / pnow;
      const newPos = bot.posToken + qty;
      bot.avgSol   = newPos > 0 ? (bot.avgSol * bot.posToken + executedSol) / newPos : pnow;
      bot.posToken = newPos;
      bot.solBalance = Math.max(0, (bot.solBalance ?? 0) - executedSol - FEE_EST_SOL * executedSlices);
      bot.tokenBalance = bot.posToken;

      buysInRow++; sellsInRow = 0; lastBuyTs = Date.now();
      lastBuyAtPrice = pnow; lastBuyAtTs = Date.now();
      if (trailHighPrice <= 0 || pnow > trailHighPrice) trailHighPrice = pnow;
    } else {
      const sellQty = executedTok > 0 ? executedTok : (amountTok ?? bot.posToken);
      bot.realized  = safeAdd(bot.realized || 0, safeMultiply((pnow || 0) - (bot.avgSol || pnow || 0), sellQty || 0));
      bot.posToken  = Math.max(0, bot.posToken - sellQty);
      bot.avgSol    = bot.posToken > 0 ? bot.avgSol : 0;
      bot.solBalance = Math.max(0, (bot.solBalance ?? 0) + Math.max(0, sellQty * pnow - FEE_EST_SOL * executedSlices));
      bot.tokenBalance = bot.posToken;

      sellsInRow++; buysInRow = 0; lastSellTs = Date.now();
      if (bot.posToken <= 0) trailHighPrice = 0;
    }

    bot.unrealized = safeMultiply(bot.posToken || 0, (pnow || 0) - (bot.avgSol || pnow || 0));
    bot.fills += executedSlices;
    bot.last  = side === "buy"
      ? `buy ${executedSol.toFixed(6)} SOL @ slp=${(usedBps).toFixed(0)}bps`
      : `sell ${roundTok(executedTok, decimals)} TOK @ slp=${(usedBps).toFixed(0)}bps`;

    pushUpdate({
      last: bot.last, fills: bot.fills, posToken: bot.posToken, avgSol: bot.avgSol,
      realized: bot.realized, unrealized: bot.unrealized, solBalance: bot.solBalance, tokenBalance: bot.tokenBalance,
      lastError: undefined,
    });
    log("ok", `${side.toUpperCase()} executed (slices ${executedSlices})`);

    await refreshOnChainBalances();
    try { ctx.afterTrade?.(); } catch {}

    try {
      const { tokVal, total, a } = alloc(pnow);
      const reserve = Math.max(MIN_KEEP_SOL, Number(risk.reserveSol) || 0);
      const gmin = Math.max(120, Number(risk.minSliceGapMs) || 200);
      const gmax = Math.max(gmin + 50, Number(risk.maxSliceGapMs) || 850);

      if (a > MAX_ALLOC + 0.002) {
        const targetVal = TARGET_ALLOC * total;
        const gapTok    = Math.max(0, (tokVal - targetVal) / pnow);
        const capPct    = Math.min(0.5, Math.max(0.02, Number(risk.maxSellSliceTokPct) || 0.12));
        const maxTok    = Math.min(bot.posToken * capPct, gapTok);
        const amt       = roundTok(Math.max(0, maxTok), decimals);
        if (amt > 0) scheduleSell(amt, gmin, gmax);
      } else if (a < MIN_ALLOC - 0.002) {
        const targetVal = TARGET_ALLOC * total;
        const needSol   = Math.max(0, targetVal - tokVal);
        const headroom  = Math.max(0, (bot.solBalance ?? 0) - (reserve + 0.0001));
        let buySol      = Math.max(0, Math.min(needSol, headroom, Math.max(0.00005, Number(risk.maxBuySliceSol) || 0.0018)));
        if (buySol > 0.00005) {
          const delay = gmin + Math.floor(Math.random() * Math.max(1, gmax - gmin));
          setTimeout(() => { twapBuy(+buySol.toFixed(6)).catch(() => {}); }, delay);
        } else if (needSol > 0 && headroom <= 0) {
          const wantSol = Math.min(needSol * 0.3, (reserve + 0.001) - (bot.solBalance ?? 0));
          const sellTok = roundTok(Math.max(0, Math.min(bot.posToken * (Number(risk.maxSellSliceTokPct) || 0.12), wantSol / pnow)), decimals);
          if (sellTok > 0) scheduleSell(sellTok, gmin, gmax);
        }
      }
    } catch {}

    cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
  }

  async function twapBuy(totalSol: number) {
    const plan = ctx.twap;
    if (!plan || plan.slices < 2 || totalSol <= 0) { await trade("buy", totalSol); return; }
    const per = Math.max(0, totalSol / plan.slices);
    for (let i = 0; i < plan.slices; i++) {
      await trade("buy", per);
      if (i < plan.slices - 1) await sleep(Math.max(300, plan.gapMs));
    }
  }

  setTimeout(loop, 100 + Math.floor(Math.random() * 500));
  return () => { stopped = true; };

  async function loop() {
    if (stopped || !bot.running || ctx.abortSignal?.aborted) return;
    if (pending) return;

    const now = Date.now();
    if (now < nextRetryAt) { setTimeout(loop, Math.max(200, nextRetryAt - now)); return; }
    if (now < cooldownUntil) { setTimeout(loop, Math.max(50, cooldownUntil - now)); return; }

    if (lossCooldownUntil && now >= lossCooldownUntil) { log("info", "loss cooldown ended"); lossCooldownUntil = 0; }

    if (deferredSell && now >= deferredSell.dueAt && bot.posToken > 0) {
      pending = true;
      try {
        if (now - (lastBuyTs || 0) < 8000) {
          deferredSell = null; pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
        const capPct = Math.min(0.5, Math.max(0.005, 0.035));
        const capTok = roundTok(bot.posToken * capPct, ctx.tokenDecimals());
        const qty    = Math.min(capTok, Math.min(bot.posToken * 0.2, Math.max(0, deferredSell.amountTok)));
        if (qty > 0) await trade("sell", 0, { sellTokens: qty });
      } catch {}
      deferredSell = null;
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }

    pending = true;
    try {
      if (ctx.shouldLightRefresh?.(10000)) { await refreshOnChainBalances(); ctx.setLightRefresh?.(); }

      if (ctx.isAiPaused && ctx.isAiPaused()) {
        bot.last = "ai:off"; pushUpdate({ last: bot.last });
        pending = false;
        const jitter = 200 + Math.floor(Math.random() * 300);
        return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
      }

      const p = Math.max(1e-12, ctx.price());
      priceHist.push(p); if (priceHist.length > 120) priceHist.shift();
      const fast = ctx.changeFast?.(12) ?? 0;
      const ch1m = ctx.change1m();

      const { a: allocTok, total } = alloc(p);
      const portfolioNow = bot.solBalance + bot.posToken * p;
      if (baselineValue === 0) baselineValue = portfolioNow;

      let risk: any = ctx.getRisk?.() || {};
      const protect = portfolioNow < baselineValue * (1 - Math.min(MAX_TOTAL_DRAWDOWN, risk.maxDrawdown ?? 0.12));

      try {
        const thr = Math.max(0, Number(risk.lossThrPct) || 0);
        const win = Math.max(0, Number(risk.lossWindowMs) || 0);
        const cool= Math.max(0, Number(risk.lossCooldownMs) || 0);
        const since= now - (lastBuyAtTs || 0);
        if (lastBuyAtPrice && win > 0 && since <= win) {
          const drop = Math.max(0, (lastBuyAtPrice - p) / Math.max(1e-12, lastBuyAtPrice));
          if (drop >= thr) {
            const until = now + cool;
            if (until > lossCooldownUntil) {
              lossCooldownUntil = until;
              log("warn", `start cooldown: drop ${(drop*100).toFixed(2)}% ≥ ${(thr*100).toFixed(2)}%, ${Math.round(cool/1000)}s`);
            }
            lastBuyAtPrice = null;
          }
        } else if (win > 0 && since > win) lastBuyAtPrice = null;
      } catch {}

      if (bot.posToken > 0) trailHighPrice = Math.max(trailHighPrice || p, p); else trailHighPrice = 0;

      let step = { minSol: 0.0002, maxSol: 0.0008, slicesMax: 4, jitterPct: 0.25 };
      try { const s = (ctx as any).getTradeStep?.(); if (s) step = s; } catch {}
      const cap = capsForStrategy(bot.strategy as InternalStrategy);
      step.minSol = +(step.minSol * cap.stepMulMin).toFixed(6);
      step.maxSol = +(step.maxSol * cap.stepMulMax).toFixed(6);
      const volScoreForStep = Math.max(Math.abs(ctx.changeFast?.(8) || 0), Math.abs(ctx.change1m?.() || 0));
      if (volScoreForStep > 0.006) step.maxSol = +(step.maxSol * 0.8).toFixed(6);
      const pickStep = () => {
        const base = step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
        const jitter = 1 + (Math.random() * 2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
        return Math.max(0.00005, +(base * jitter).toFixed(6));
      };

      const reserve = Math.max(MIN_KEEP_SOL, risk.reserveSol || 0.0009);
      const baseSize = Math.max(step.minSol, Math.min(bot.budgetSol || ctx.tradeSize() || step.maxSol, bot.solBalance - (reserve + step.minSol)));
      const haveSol = bot.solBalance > reserve + 0.00015;
      const eps = 0.005;

      if (bot.posToken > 0 && bot.solBalance < reserve) {
        const needSol  = Math.max(0, (reserve + 0.0015) - bot.solBalance);
        const tokToSell= roundTok(Math.min(bot.posToken * 0.22, needSol / Math.max(1e-12, p)), ctx.tokenDecimals());
        if (tokToSell > 0) {
          await trade("sell", 0, { sellTokens: tokToSell });
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      if (bot.posToken > 0 && allocTok > MAX_ALLOC + eps) {
        const desiredTokVal = TARGET_ALLOC * total;
        const currentTokVal = bot.posToken * p;
        const excessVal     = Math.max(0, currentTokVal - desiredTokVal);
        const over          = allocTok - MAX_ALLOC;
        const factor        = over > 0.03 ? 1.0 : over > 0.015 ? 0.75 : 0.5;
        const tokToSell     = Math.min(bot.posToken, roundTok(Math.max(bot.posToken * 0.12, (excessVal * factor) / p), ctx.tokenDecimals()));
        if (tokToSell > 0) {
          await trade("sell", 0, { sellTokens: tokToSell });
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      if (!protect && allocTok < MIN_ALLOC - eps) {
        if (!haveSol) {
          const targetVal = TARGET_ALLOC * total;
          const needVal   = Math.max(0, targetVal - bot.posToken * p);
          const tokToSell = roundTok(Math.max(bot.posToken * 0.08, Math.min(bot.posToken * 0.2, (needVal * 0.25) / p)), ctx.tokenDecimals());
          if (tokToSell > 0) {
            await trade("sell", 0, { sellTokens: tokToSell });
            pending = false;
            const jitter = 200 + Math.floor(Math.random() * 300);
            return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
          }
        }
        const targetVal = TARGET_ALLOC * total;
        const needVal   = Math.max(0, targetVal - bot.posToken * p);
        const buySol    = Math.max(0, Math.min(Math.min(baseSize, pickStep()), needVal));
        if (buySol > 0.00005) {
          await twapBuy(buySol);
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      let did = false;
      const strat = bot.strategy as InternalStrategy;

      switch (strat) {
        case "trend": {
          if (buysInRow >= 2 && fast > 0.001 && trailHighPrice > 0 && p < trailHighPrice * 0.9995) {
            const pause = bot.speedMs * (1 + Math.random());
            cooldownUntil = Date.now() + Math.max(600, Math.min(2400, pause));
            log("info", `micro-cooldown ${Math.round(pause)}ms`);
            break;
          }
          if (!protect && haveSol && fast > 0 && ch1m > 0.001 && allocTok < MAX_ALLOC) {
            const headroomToMax = Math.max(0, MAX_ALLOC * total - bot.posToken * p);
            const size = Math.min(Math.min(baseSize, pickStep()), headroomToMax);
            if (size > 0.00005) { await twapBuy(size); did = true; break; }
          }
          if (bot.posToken > 0 && bot.avgSol > 0) {
            const r = (p - bot.avgSol) / Math.max(1e-9, bot.avgSol);
            if (r >= 0.07) {
              const pct = 0.08 + Math.random() * 0.10;
              const part= roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
              if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; break; }
            }
          }
          if (!did && bot.posToken > 0 && trailHighPrice > 0) {
            const dd = (p - trailHighPrice) / Math.max(1e-9, trailHighPrice);
            if (dd <= -0.009) {
              const pct = 0.06 + Math.random() * 0.06;
              const part= roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
              if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; break; }
            }
          }
          if (!did && (allocTok > MAX_ALLOC || protect)) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal     = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(bot.posToken, roundTok(Math.max(bot.posToken * 0.10, (excessVal * 0.5) / p), ctx.tokenDecimals()));
            if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; }
          }
          break;
        }
        case "revert": {
          const N = Math.min(90, priceHist.length);
          const M = Math.max(12, Math.min(36, N));
          const slice = priceHist.slice(-M);
          const mean = slice.reduce((s, x) => s + x, 0) / Math.max(1, slice.length);
          const sd   = Math.sqrt(slice.reduce((s, x) => s + (x - mean) * (x - mean), 0) / Math.max(1, slice.length));
          const dev  = mean > 0 ? (p - mean) / mean : 0;

          if (!protect && haveSol && allocTok < (MAX_ALLOC - 0.001) && fast < 0 && dev <= -0.007 && Date.now() >= lossCooldownUntil) {
            const headroomToMax = Math.max(0, MAX_ALLOC * total - bot.posToken * p);
            const size = Math.min(Math.min(baseSize, pickStep()), headroomToMax);
            if (size > 0.00005) { await twapBuy(size); did = true; break; }
          }
          const smallProfit = bot.avgSol > 0 ? (p - bot.avgSol) / Math.max(1e-9, bot.avgSol) >= 0.012 : false;
          const nearMean    = Math.abs(dev) <= 0.0015;
          if (!did && bot.posToken > 0 && (smallProfit || nearMean)) {
            const pct  = 0.08 + Math.random() * 0.07;
            const part = roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
            if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; }
          }
          if (!did && bot.posToken > 0 && dev >= 0.008) {
            const pct  = 0.08 + Math.random() * 0.07;
            const part = roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
            if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; }
          }
          if (!did && buysInRow > 0 && bot.posToken > 0 && !deferredSell) {
            const planned = roundTok(Math.max(bot.posToken * 0.04, bot.posToken * 0.03 + Math.random() * bot.posToken * 0.03), ctx.tokenDecimals());
            if (planned > 0) scheduleSell(planned, 1600, 3400);
          }
          break;
        }
        case "scalper": {
          if (!protect && haveSol && Math.abs(fast) > 0.0018 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.12) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()), headroomVal);
            if (size > 0.00005) { await twapBuy(size); did = true; break; }
          }
          const wantSell = (() => {
            const avg = bot.avgSol || p;
            const r   = (p - avg) / Math.max(1e-9, avg);
            return r >= 0.012 || r <= -0.005;
          })();
          if (wantSell || allocTok > MAX_ALLOC || protect) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal     = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(bot.posToken, roundTok(Math.max(bot.posToken * 0.12, (excessVal * 0.45) / p), ctx.tokenDecimals()));
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          } else if (bot.posToken > 0 && buysInRow >= 2) {
            const shave = roundTok(Math.max(bot.posToken * 0.06, bot.posToken * Math.random() * 0.08), ctx.tokenDecimals());
            if (shave > 0) { await trade("sell", 0, { sellTokens: shave }); did = true; }
          }
          break;
        }
        case "momentum": {
          if (!protect && haveSol && (fast > 0.001 || ch1m > 0.002) && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()*1.2), headroomVal);
            if (size > 0.00005) { await twapBuy(size); did = true; break; }
          }
          if (bot.posToken > 0 && trailHighPrice > 0) {
            const dd = (p - trailHighPrice) / Math.max(1e-9, trailHighPrice);
            if (dd < -0.009) {
              const part = roundTok(Math.max(bot.posToken * 0.1, bot.posToken * 0.06 + Math.random() * 0.06), ctx.tokenDecimals());
              await trade("sell", 0, { sellTokens: part });
              did = true; break;
            }
          }
          const want = (() => {
            const avg = bot.avgSol || p;
            const r   = (p - avg) / Math.max(1e-9, avg);
            return r >= 0.015 || allocTok > MAX_ALLOC || protect;
          })();
          if (want) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal     = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(bot.posToken, roundTok(Math.max(bot.posToken * 0.18, (excessVal * 0.55) / p), ctx.tokenDecimals()));
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }
        case "range": {
          const mid = bot.avgSol || p;
          const dev = (p - mid) / Math.max(1e-9, mid);
          if (!protect && haveSol && dev < -0.01 && allocTok < MAX_ALLOC) {
            const size = Math.min(Math.max(baseSize, pickStep()), (TARGET_ALLOC + 0.1) * total);
            if (size > 0.00005) { await twapBuy(size); did = true; break; }
          }
          if (dev > 0.012 || allocTok > MAX_ALLOC || protect) {
            const part = roundTok(Math.max(bot.posToken * 0.12, (bot.posToken * dev) / 2), ctx.tokenDecimals());
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }
        case "maker": {
          if (!protect && allocTok < MAX_ALLOC && haveSol) {
            const size = Math.min(pickStep() * 0.6, baseSize);
            if (Math.random() < 0.6) { await twapBuy(size); did = true; break; }
          }
          if (bot.posToken > 0 && (allocTok > TARGET_ALLOC || protect || Math.random() < 0.35)) {
            const part = roundTok(Math.max(bot.posToken * 0.07, (bot.posToken * Math.random() * 0.1)), ctx.tokenDecimals());
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          } else if (!did && bot.posToken > 0 && !deferredSell) {
            const planned = roundTok(Math.max(bot.posToken * 0.03, bot.posToken * 0.02 + Math.random() * bot.posToken * 0.03), ctx.tokenDecimals());
            scheduleSell(planned, 1200, 2600);
          }
          break;
        }
      }

      if (!did) {
        if (bot.posToken > 0) {
          const sinceSell = Date.now() - (lastSellTs || 0);
          if (buysInRow >= 2 || sinceSell > Math.max(7000, bot.speedMs * 2)) {
            const shave = roundTok(Math.max(bot.posToken * 0.05, bot.posToken * 0.05 + Math.random() * bot.posToken * 0.04), ctx.tokenDecimals());
            if (shave > 0) {
              await trade("sell", 0, { sellTokens: shave });
              pending = false;
              const jitter = 200 + Math.floor(Math.random() * 300);
              return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
            }
          }
        }
        bot.last = "hold";
        bot.unrealized = safeMultiply(bot.posToken || 0, (p || 0) - (bot.avgSol || p || 0));
        pushUpdate({ last: bot.last, unrealized: bot.unrealized, fills: bot.fills });
      }
    } catch (e: any) {
      failStreak++;
      const cool = Math.min(20_000, 1000 * failStreak);
      nextRetryAt = Date.now() + cool;
      bot.lastError = e?.message || String(e);
      pushUpdate({ lastError: bot.lastError });
      warn(`net fail (${failStreak}) — ${bot.lastError}; retry in ${Math.round(cool / 1000)}s`);
    } finally {
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      if (!stopped && !ctx.abortSignal?.aborted) setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }
  }
}
