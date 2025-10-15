
import {
  Connection,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getSPLBalance } from "../utils/solana";
import { scheduleFetch } from "../utils/network";
import { getJupiterQuote, WSOL } from "../utils/jupiter";
import { safeMultiply, safeAdd } from "../utils/number";
import { confirmSigHttp } from "../utils/confirm";
/* ───────────────────────────── Types ───────────────────────────── */
type BotStrategy = "trend" | "revert" | "scalper";
// расширим внутренний набор архетипов без ломающего изменения типа
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

  onLog: (level: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
  // FIX: у стора уже есть afterTrade — дергаем мягкий рефреш после сделок
  afterTrade?: () => void;
};

/* ─────────────────────── Net bases & utilities ─────────────────────── */
// prefer your backend → custom pump API → public pump portal
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const ALT_PUMP = ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, "");
const PUMP_BASES = [API_BASE ? `${API_BASE}/x/pump` : "", ALT_PUMP, "https://pumpportal.fun"].filter(Boolean);
const PF_BASE_SOL = Math.max(0.000006, Number(((import.meta as any).env?.VITE_PRIORITY_FEE_BASE) ?? 0.000008));
const PF_MAX_SOL  = Math.max(PF_BASE_SOL, Number(((import.meta as any).env?.VITE_PRIORITY_FEE_MAX)  ?? 0.00012));
// === очередь с ограничением конкурентности (глобально на вкладку)
type Job<T> = () => Promise<T>;
function makeQueue(concurrency = 3, baseGapMs = 150) {
  const q: Array<{ job: Job<any>; resolve: (v: any) => void; reject: (e: any) => void }> = [];
  let running = 0;

  async function runNext() {
    if (running >= concurrency) return;
    const item = q.shift();
    if (!item) return;
    running++;
    try {
      const jitter = baseGapMs + Math.floor(Math.random() * baseGapMs);
      const res = await item.job();
      await new Promise((r) => setTimeout(r, jitter)); // spacing между сборками
      item.resolve(res);
    } catch (e) {
      item.reject(e);
    } finally {
      running--;
      runNext();
    }
  }

  return function enqueue<T>(job: Job<T>): Promise<T> {
    return new Promise((resolve, reject) => {
      q.push({ job, resolve, reject });
      runNext();
    });
  };
}

const TB_CONC = Math.max(1, Number(((import.meta as any).env?.VITE_TRADE_BUILD_CONC) ?? 12));
const TB_GAP  = Math.max(20, Number(((import.meta as any).env?.VITE_TRADE_BUILD_GAP_MS) ?? 60));
const enqueueTradeBuild: <T>(fn: () => Promise<T>) => Promise<T> =
  (window as any).__tradeQ || ((window as any).__tradeQ = makeQueue(TB_CONC, TB_GAP));

function withTimeout<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fetch timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

// “липкий” base (если один из эндпоинтов надёжен — держимся за него)
let stickyBaseIdx = -1;

async function fetchFirstOk(path: string, init: RequestInit = {}, retries = 3) {
  const order = [...PUMP_BASES.keys()];
  if (stickyBaseIdx >= 0) {
    const i = order.indexOf(stickyBaseIdx);
    if (i > 0) { order.splice(i, 1); order.unshift(stickyBaseIdx); }
  }

  let lastErr: any;
  for (const idx of order) {
    const base = PUMP_BASES[idx];
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      const backoff = attempt === 0 ? 0 : 300 * attempt + Math.floor(Math.random() * 250);
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
      try {
        const r = await scheduleFetch(url, {
          ...(init as any),
          timeoutMs: 20_000,
          tries: 1,
        }, "pump");

        if (r.ok) { stickyBaseIdx = idx; return r; }
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`${r.status} ${r.statusText}`);
          continue;
        }
        const txt = await r.text().catch(() => "");
        throw new Error(`${r.status} ${r.statusText}${txt ? `: ${txt}` : ""}`);
      } catch (e) {
        lastErr = e;
      }
    }
  }
  stickyBaseIdx = -1;
  throw lastErr || new Error("All pump endpoints failed");
}

/** Build Versioned TX with throttling, timeout, retries & fallback */
async function buildTradeTxPumpPortal(payload: Record<string, any>): Promise<VersionedTransaction> {
  return enqueueTradeBuild(async () => {
    const attempts: Array<{ path: string; binary: boolean }> = [
      { path: "/api/trade-local", binary: true }, // binary stream (faster)
      { path: "/api/trade", binary: false },      // JSON fallback
    ];
    let lastErr: any;
    for (const a of attempts) {
      try {
        const r = await fetchFirstOk(a.path, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify(payload),
        });
        const ct = r.headers.get("content-type") || "";
        if (a.binary && ct.includes("application/octet-stream")) {
          const raw = new Uint8Array(await r.arrayBuffer());
          return VersionedTransaction.deserialize(raw);
        }
        const j = (await r.json().catch(() => ({}))) as any;
        const b64 = j?.serializedTransaction || j?.tx || j?.transaction || j?.vtx || null;
        if (!b64) throw new Error("no transaction in response");
        const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
        return VersionedTransaction.deserialize(raw);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("trade build failed");
  });
}

/* ─────────────────── Portfolio / strategy helpers ─────────────────── */
const FEE_EST_SOL = 0.00002; // ~20k lamports
const MIN_KEEP_SOL = 0.0006;

// Цель: ~70% в токене / 30% в SOL (с коридором)
let TARGET_ALLOC = 0.70;
let MAX_ALLOC = 0.85; // при превышении — частичная продажа
let MIN_ALLOC = 0.60; // при падении ниже — ребаланс в покупку

// Риск-ограничители
const MAX_SINGLE_TRADE_IMPACT = 0.015; // tighter default: 1.5%
const MAX_TOTAL_DRAWDOWN = 0.30;       // при просадке портфеля >30% — защита
const MAX_ROUNDTRIP_LOSS = 0.008;      // tighter default: 0.8%

const MIN_SLP_BPS = 30;  // adaptive slippage lower bound
const MAX_SLP_BPS = 120; // adaptive slippage upper bound

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function roundTok(tokens: number, decimals: number) {
  const p = Math.pow(10, Math.min(6, decimals));
  return Math.max(0, Math.floor(tokens * p) / p);
}

function wantToSell(bot: LiveBot, currPrice: number, takeProfitBps: number, stopLossBps: number) {
  if (bot.posToken <= 0 || !bot.avgSol) return false;
  const chg = (currPrice - bot.avgSol) / Math.max(1e-9, bot.avgSol);
  if (chg >= takeProfitBps / 10_000) return true;
  if (chg <= -stopLossBps / 10_000) return true;
  return false;
}

/* ───────────────────────────── Runner ───────────────────────────── */
export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;
  let cooldownUntil = 0;

  // per-bot backoff if trade building fails
  let failStreak = 0;
  let nextRetryAt = 0;
  let lastWarnTs = 0;

  // Базовая стоимость портфеля для защиты от просадки
  let baselineValue = 0;

  // Поведенческие счётчики/слежение
  let buysInRow = 0;
  let sellsInRow = 0;
  let lastBuyTs = 0;
  let lastSellTs = 0;
  let trailHighPrice = 0;
  let deferredSell: { dueAt: number; amountTok: number } | null = null;
  const priceHist: number[] = [];

  function scheduleSell(amountTok: number, minMs: number, maxMs: number) {
    const now = Date.now();
    const delay = Math.max(0, minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)));
    deferredSell = { dueAt: now + delay, amountTok: Math.max(0, amountTok) };
  }

  function capsForStrategy(strat: InternalStrategy) {
    switch (strat) {
      case "trend":    return { buySlice: 0.0015, sellPct: 0.10, stepMulMin: 1.0, stepMulMax: 1.0 };
      case "revert":   return { buySlice: 0.0012, sellPct: 0.14, stepMulMin: 0.8, stepMulMax: 0.9 };
      case "scalper":  return { buySlice: 0.0009, sellPct: 0.08, stepMulMin: 0.5, stepMulMax: 0.6 };
      case "momentum": return { buySlice: 0.0018, sellPct: 0.12, stepMulMin: 1.1, stepMulMax: 1.3 };
      case "range":    return { buySlice: 0.0010, sellPct: 0.10, stepMulMin: 0.7, stepMulMax: 0.9 };
      case "maker":    return { buySlice: 0.0006, sellPct: 0.06, stepMulMin: 0.4, stepMulMax: 0.5 };
      default:          return { buySlice: 0.0012, sellPct: 0.10, stepMulMin: 1.0, stepMulMax: 1.0 } as any;
    }
  }

  const log = (lvl: "info" | "ok" | "warn" | "err", s: string) => ctx.onLog(lvl, `[${bot.name}] ${s}`);
  const warnDebounced = (s: string) => {
    const now = Date.now();
    if (now - lastWarnTs > 2000) { lastWarnTs = now; log("warn", s); }
  };

  function pushUpdate(p: Partial<LiveBot>) {
    ctx.onUpdate({ id: bot.id, ...p } as any);
  }

  const alloc = (priceNow: number) => {
    const tokVal = bot.posToken * priceNow;
    const total = Math.max(1e-9, tokVal + bot.solBalance);
    return { tokVal, total, a: tokVal / total };
  };

  // per-bot rolling rate/limits state
  let minWindowStart = Date.now();
  let buysThisMin = 0;
  let sellsThisMin = 0;
  let notionalThisMin = 0; // суммарная сумма покупок в SOL
  let lastBuyAtPrice: number | null = null;
  let lastBuyAtTs: number = 0;
  let lossCooldownUntil = 0;

  async function refreshOnChainBalances() {
    try {
      const kp = ctx.keypair();
      const lam = await connection.getBalance(kp.publicKey, "processed");
      const sol = lam / LAMPORTS_PER_SOL;
      const raw = await getSPLBalance(connection, bot.pubkey, ctx.mint);
      const tok = Number(raw as any) / Math.pow(10, ctx.tokenDecimals());
      bot.solBalance = sol;
      bot.tokenBalance = tok;
      pushUpdate({ solBalance: sol, tokenBalance: tok });
    } catch { /* soft */ }
  }

  async function trade(
    side: "buy" | "sell",
    sizeSol: number,
    opts?: { sellTokens?: number }
  ) {
    // Риск-профиль из стора (без UI)
    let risk = { maxImpact: 0.010, maxDrawdown: 0.12, reserveSol: 0.0060, maxNotionalPerMin: 0.0008, maxBuysPerMin: 1, maxSellsPerMin: 4, lossThrPct: 0.003, lossWindowMs: 30000, lossCooldownMs: 180000, maxBuySliceSol: 0.00035, maxSellSliceTokPct: 0.035, minSliceGapMs: 600, maxSliceGapMs: 1800 } as any;
    try { const r = (ctx as any).getRisk?.(); if (r) risk = r; } catch {}

    // Подхватываем актуальные аллокации из UI (если переданы)
    try {
      const allocUI = (ctx as any).getAlloc?.();
      if (allocUI && typeof allocUI.target === 'number') {
        TARGET_ALLOC = Math.min(0.95, Math.max(0.05, allocUI.target));
        MIN_ALLOC = Math.min(TARGET_ALLOC, Math.max(0.05, allocUI.min ?? 0.6));
        MAX_ALLOC = Math.max(TARGET_ALLOC, Math.min(0.98, allocUI.max ?? 0.85));
      }
    } catch {}
    // Подхватываем форму шага сделки
    let step = { minSol: 0.0002, maxSol: 0.0008, slicesMax: 4, jitterPct: 0.25 };
    try { const s = (ctx as any).getTradeStep?.(); if (s) step = s; } catch {}
    const pickStep = () => {
      const base = step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
      const jitter = 1 + (Math.random()*2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
      return Math.max(0.00005, +(base * jitter).toFixed(6));
    };
    const kp = ctx.keypair();
    const decimals = ctx.tokenDecimals();
    const priceNow = Math.max(1e-12, ctx.price());

    let amountTok: number | undefined =
      side === "sell" && opts?.sellTokens ? roundTok(opts.sellTokens, decimals) : undefined;

    // Жесткие ограничения коридора перед исполнением
    try {
      const { a, total } = alloc(priceNow);
      const EPS = 0.002;
      // строгая остановка на границах
      if (side === "buy" && a >= MAX_ALLOC - EPS) {
        log("info", "skip BUY: at or above maxAlloc");
        return;
      }
      if (side === "sell" && a <= MIN_ALLOC + EPS) {
        // продажи запрещены на нижней границе (за исключением экстренных в другом месте)
        // тут обычные продажи блокируются
        if (!opts?.sellTokens) { log("info", "skip SELL: at or below minAlloc"); return; }
      }
      if (side === "buy" && sizeSol > 0) {
        const currTokVal = bot.posToken * priceNow;
        // после покупки: (currTokVal + sizeSol) / total <= MAX_ALLOC - EPS
        const maxBuyVal = Math.max(0, (Math.max(0, MAX_ALLOC - EPS)) * total - currTokVal);
        const original = sizeSol;
        const clamped = Math.min(sizeSol, maxBuyVal);
        if (clamped <= 0.00012) { log("info", "skip BUY: corridor"); return; }
        sizeSol = +clamped.toFixed(6);
        if (sizeSol < original - 1e-9) {
          log("info", `clamped buy from ${original.toFixed(6)} → ${sizeSol.toFixed(6)} to stay ≤ maxAlloc`);
        }
      } else if (side === "sell") {
        // после продажи: (currTokVal - sellTok * price) / total >= MIN_ALLOC + EPS
        const currTokVal = bot.posToken * priceNow;
        const minTokValAfter = Math.max(0, (Math.min(0.98, MIN_ALLOC + EPS)) * total);
        const maxSellTok = Math.max(0, (currTokVal - minTokValAfter) / Math.max(1e-12, priceNow));
        if (opts?.sellTokens) {
          const originalTok = opts.sellTokens;
          const newAmt = Math.min(opts.sellTokens, maxSellTok);
          if (newAmt <= 0) { log("info", "skip SELL: corridor"); return; }
          (opts as any).sellTokens = newAmt;
          amountTok = roundTok(newAmt, decimals);
          if (newAmt < originalTok - 1e-12) {
            log("info", `clamped sell from ${roundTok(originalTok, decimals)} → ${roundTok(newAmt, decimals)} to stay ≥ minAlloc`);
          }
        } else if ((amountTok ?? bot.posToken) > 0) {
          const originalTok = (amountTok ?? bot.posToken);
          const capped = Math.min((amountTok ?? bot.posToken), maxSellTok);
          if (capped <= 0) { log("info", "skip SELL: corridor"); return; }
          (opts as any) = { ...(opts || {}), sellTokens: capped };
          amountTok = roundTok(capped, decimals);
          if (capped < originalTok - 1e-12) {
            log("info", `clamped sell from ${roundTok(originalTok, decimals)} → ${roundTok(capped, decimals)} to stay ≥ minAlloc`);
          }
        }
      }
    } catch {}

    if (side === "buy" && sizeSol <= 0) { log("info", "skip BUY: corridor"); return; }
    if (side === "sell" && (amountTok ?? bot.posToken) <= 0) { log("info", "skip SELL: corridor"); return; }

    // Строгий резерв SOL перед покупками
    if (side === 'buy') {
      const reserve = Math.max(MIN_KEEP_SOL, Number(risk.reserveSol) || 0);
      const step = { ...(ctx as any).getTradeStep?.() ?? { minSol: 0.0002, maxSol: 0.0008 } } as any;
      const need = reserve + Math.max(0.00005, Number(step.minSol) || 0.0002);
      if ((bot.solBalance ?? 0) < need) {
        log("info", "skip BUY: low SOL; scheduling tiny SELL to raise fee buffer");
        if (bot.posToken > 0) {
          const wantSol = Math.min(0.0015, need - (bot.solBalance ?? 0));
          const sellTok = roundTok(Math.max(0, Math.min(bot.posToken * (Number(risk.maxSellSliceTokPct) || 0.035), wantSol / Math.max(1e-12, priceNow))), decimals);
          if (sellTok > 0) {
            const gmin = Math.max(120, Number((risk as any).minSliceGapMs) || 600);
            const gmax = Math.max(gmin + 50, Number((risk as any).maxSliceGapMs) || 1800);
            scheduleSell(sellTok, gmin, gmax);
          }
        }
        return;
      }
    }

    // Минутные лимиты и cooldown на потери
    const nowTs = Date.now();
    if (nowTs - minWindowStart >= 60_000) { minWindowStart = nowTs; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
    if (side === 'buy') {
      if (nowTs < lossCooldownUntil) { log("info", "skip BUY: cooldown"); return; }
      if (buysThisMin >= risk.maxBuysPerMin) { log("info", "skip: minute limits"); return; }
      if (notionalThisMin + sizeSol > risk.maxNotionalPerMin) { log("info", "skip: minute limits"); return; }
    } else {
      if (sellsThisMin >= risk.maxSellsPerMin) { log("info", "skip: minute limits"); return; }
    }

    // Adaptive slippage: clamp getSmartBps() into [30..120] depending on short-term volatility
    const short = Math.abs(ctx.changeFast?.(12) || 0);
    const oneMin = Math.abs((ctx.change1m?.() as any) || 0);
    const volScore = Math.max(short, oneMin);
    let lo = MIN_SLP_BPS, hi = MAX_SLP_BPS;
    if (volScore < 0.002) { lo = 30; hi = 60; }
    else if (volScore < 0.006) { lo = 50; hi = 90; }
    else { lo = 80; hi = 120; }
    const rawBps = Number((ctx as any).slippageBps?.() ?? 50);
    const usedBps = Math.round(Math.max(lo, Math.min(hi, rawBps)));
    const multByFail = failStreak >= 4 ? 4 : (failStreak >= 2 ? 2 : 1);
    let priorityFeeSol = PF_BASE_SOL * multByFail * (volScore > 0.006 ? 1.35 : (volScore > 0.003 ? 1.15 : 1.0));
    priorityFeeSol = Math.min(PF_MAX_SOL, +priorityFeeSol.toFixed(6));

    const payload =
      side === "buy"
        ? {
            publicKey: kp.publicKey.toBase58(),
            action: "buy",
            mint: ctx.mint,
            denominatedInSol: "true",
            amount: sizeSol,
            slippage: usedBps / 100,
            priorityFee: priorityFeeSol,
            pool: "auto",
          }
        : {
            publicKey: kp.publicKey.toBase58(),
            action: "sell",
            mint: ctx.mint,
            denominatedInSol: "false",
            amount: amountTok ?? roundTok(bot.posToken, decimals),
            slippage: usedBps / 100,
            priorityFee: priorityFeeSol,
            pool: "auto",
          };

    try {
      // Защита от сверхплохих котировок: Jupiter sanity check
      // Allow tests to inject a custom quote function without changing public API
      const quoteFn = (ctx as any).getJupiterQuote || getJupiterQuote;

      if (side === 'buy') {
        const pay = Math.round(Math.max(0.00005, sizeSol || pickStep()) * 1e9);
        try {
          const q = await quoteFn({ inputMint: WSOL, outputMint: ctx.mint, amount: pay });
          const fairOut = (pay / 1e9) / priceNow; // в токенах
          const out = Number(q.outAmount || 0) / Math.pow(10, decimals);
          if (!isFinite(out) || out <= 0) { warnDebounced("skip BUY: illiquid route or out=0"); return; }
          const maxImpact = Math.max(0, Math.min(0.2, Number((risk as any).maxImpact ?? MAX_SINGLE_TRADE_IMPACT)));
          const impact = fairOut > 0 ? Math.max(0, 1 - out / fairOut) : 1;
          if (fairOut > 0 && impact > maxImpact) {
            warnDebounced(`skip BUY: impact ${(impact*100).toFixed(1)}% > ${(maxImpact*100).toFixed(1)}%`);
            return;
          }
          // Roundtrip-loss check: WSOL -> TOK -> WSOL на маленькой пробе
          const RT_SAMPLE = Math.min(1, Math.max(0, Number(((import.meta as any).env?.VITE_RT_SAMPLE) ?? 0.33)));
          if (out > 0 && Math.random() < RT_SAMPLE) {
            try {
              const backRaw = Math.max(1, Math.round(out * Math.pow(10, decimals)));
              const qb = await quoteFn({ inputMint: ctx.mint, outputMint: WSOL, amount: backRaw });
              const backSol = Number(qb.outAmount || 0) / 1e9;
              const lossPct = Math.max(0, 1 - backSol / Math.max(1e-12, (pay / 1e9)));
              const maxRt = Math.max(0, Number((risk as any).maxRoundtripLoss ?? MAX_ROUNDTRIP_LOSS));
              if (isFinite(lossPct) && lossPct > maxRt) {
                warnDebounced(`skip BUY: roundtrip ${(lossPct*100).toFixed(1)}% > ${(maxRt*100).toFixed(1)}%`);
                return;
              }
              // Dynamic step sizing: if impact > 1.0% — shrink per-slice cap further
              const impForSizing = impact;
              if (impForSizing > 0.01) { (payload as any).__shrinkBuy = true; }
            } catch {}
          }
        } catch {}
      } else {
        const qty = amountTok ?? bot.posToken;
        const raw = Math.round(qty * Math.pow(10, decimals));
        try {
          const q = await quoteFn({ inputMint: ctx.mint, outputMint: WSOL, amount: raw });
          const fairOutSol = qty * priceNow;
          const outSol = Number(q.outAmount || 0) / 1e9;
          const maxImpact = Math.max(0, Math.min(0.2, Number((risk as any).maxImpact ?? MAX_SINGLE_TRADE_IMPACT)));
          if (!isFinite(outSol) || outSol <= 0) { warnDebounced("skip SELL: illiquid route or out=0"); return; }
          const impact = fairOutSol > 0 ? Math.max(0, 1 - outSol / fairOutSol) : 1;
          if (fairOutSol > 0 && impact > maxImpact) {
            warnDebounced(`skip SELL: impact ${(impact*100).toFixed(1)}% > ${(maxImpact*100).toFixed(1)}%`);
            return;
          }
        } catch {}
      }

      // FIX: caps был не объявлен в этой функции → ReferenceError
      const caps = capsForStrategy(bot.strategy as InternalStrategy);

      // Разбиваем сделки на под-ордера и для продаж тоже, чтобы избежать больших единичных продаж
      let remainingSol = side === 'buy' ? (sizeSol || pickStep()) : 0;
      let remainingTok = side === 'sell' ? (amountTok ?? bot.posToken) : 0;
      let maxBuyPerSlice = Math.max(0.00005, Math.min((risk.maxBuySliceSol || 0.0018), caps.buySlice));
      const maxSellPct = Math.min(0.5, Math.max(0.02, Math.min((risk.maxSellSliceTokPct || 0.12), caps.sellPct)));
      const maxSellPerSlice = side === 'sell' ? roundTok((bot.posToken || 0) * maxSellPct, decimals) : 0;

      let slices = Math.max(1, Math.min(step.slicesMax, Math.round(1 + Math.random() * (step.slicesMax - 1))));
      if (side === 'sell' && maxSellPerSlice > 0) {
        const need = Math.ceil(remainingTok / Math.max(1e-12, maxSellPerSlice));
        slices = Math.min(step.slicesMax, Math.max(slices, need));
      }

      // FIX: аккумулируем фактически «запрошенные» объёмы для локального апдейта
      let executedSol = 0;
      let executedTok = 0;
      let executedSlices = 0;

      // локальное состояние для mid-slice коррекции
      let localPosToken = bot.posToken;
      let localSol = bot.solBalance;
      const EPS = 0.0015;

      for (let si = 0; si < slices; si++) {
        let pl = payload as any;
        if (side === 'buy') {
          // mid-slice corridor re-evaluation
          const pnow = Math.max(1e-12, ctx.price());
          const currTokVal = localPosToken * pnow;
          const totalLocal = Math.max(1e-9, currTokVal + localSol);
          const maxBuyValLocal = Math.max(0, (Math.max(0, MAX_ALLOC - EPS)) * totalLocal - currTokVal);
          if (maxBuyValLocal <= 0) { log('info', `stop BUY slicing: next would breach maxAlloc (${(MAX_ALLOC*100).toFixed(1)}%)`); break; }
          let pay = Math.min(maxBuyPerSlice, remainingSol, maxBuyValLocal);
          if (pay <= 0.000049) break;
          pl = { ...payload, amount: +pay.toFixed(6) };
          remainingSol = Math.max(0, +(remainingSol - pay).toFixed(6));
          // лимит динамического шага при высокой волатильности или оценочном импакте
          const volScoreNow = Math.max(Math.abs(ctx.changeFast?.(8) || 0), Math.abs(ctx.change1m?.() || 0));
          if ((payload as any).__shrinkBuy || volScoreNow > 0.006) {
            maxBuyPerSlice = Math.max(0.00005, +(maxBuyPerSlice * 0.7).toFixed(6));
          }
          // пер-срезовые минутные ограничения
          const nowTs2 = Date.now();
          if (nowTs2 - minWindowStart >= 60_000) { minWindowStart = nowTs2; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
          if (buysThisMin >= (Number(risk.maxBuysPerMin) || 0)) { log("info", "skip: minute limits"); break; }
          if (notionalThisMin + pl.amount > (Number(risk.maxNotionalPerMin) || 0)) { log("info", "skip: minute limits"); break; }
        } else {
          // mid-slice corridor re-evaluation for sells
          const pnow = Math.max(1e-12, ctx.price());
          const currTokVal = localPosToken * pnow;
          const totalLocal = Math.max(1e-9, currTokVal + localSol);
          const minTokValAfter = Math.max(0, (Math.min(0.98, MIN_ALLOC + EPS)) * totalLocal);
          const maxSellTokLocal = Math.max(0, (currTokVal - minTokValAfter) / Math.max(1e-12, pnow));
          if (maxSellTokLocal <= 0) { log('info', `stop SELL slicing: next would breach minAlloc (${(MIN_ALLOC*100).toFixed(1)}%)`); break; }
          const perTok = maxSellPerSlice > 0 ? Math.min(maxSellPerSlice, remainingTok, maxSellTokLocal) : Math.min(remainingTok / Math.max(1, (slices - si)), maxSellTokLocal);
          const qty = roundTok(Math.max(0, perTok), decimals);
          if (qty <= 0) break;
          pl = { ...payload, amount: qty };
          remainingTok = Math.max(0, remainingTok - qty);
          // пер-срезовое ограничение продаж
          const nowTs2 = Date.now();
          if (nowTs2 - minWindowStart >= 60_000) { minWindowStart = nowTs2; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
          if (sellsThisMin >= (Number(risk.maxSellsPerMin) || 0)) { log("info", "skip: minute limits"); break; }
        }

        const vtx = await buildTradeTxPumpPortal(pl);
        vtx.sign([kp]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 4 });
        await confirmSigHttp(connection, sig);

        executedSlices++;
        if (side === 'buy') {
          executedSol += pl.amount;
          // локальный пост-срезовой апдейт
          localPosToken += pl.amount / Math.max(1e-12, ctx.price());
          localSol = Math.max(0, localSol - pl.amount - FEE_EST_SOL);
          buysThisMin++; // per-slice increment
          notionalThisMin = +(notionalThisMin + pl.amount).toFixed(6);
        } else {
          executedTok += pl.amount;
          localPosToken = Math.max(0, localPosToken - pl.amount);
          localSol += Math.max(0, pl.amount * Math.max(1e-12, ctx.price()) - FEE_EST_SOL);
          sellsThisMin++; // per-slice increment
        }

        // лёгкий джиттер между под-ордеров
        if (si < slices-1 && (side === 'buy' ? remainingSol > 0 : remainingTok > 0)) {
          const gmin = Math.max(120, (risk.minSliceGapMs || 600));
          const gmax = Math.max(gmin+50, (risk.maxSliceGapMs || 1800));
          const gap = gmin + Math.floor(Math.random() * (gmax - gmin));
          await sleep(gap);
        }
      }

      if (executedSlices === 0) {
        throw new Error("no slices executed");
      }

      // success → reset backoff
      failStreak = 0;
      nextRetryAt = 0;

      // FIX: учитываем ИМЕННО выполненный объём, а не несуществующий totalSol
      if (side === "buy") {
        const qty = executedSol / priceNow;
        const newPos = bot.posToken + qty;
        bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + executedSol) / newPos : priceNow;
        bot.posToken = newPos;
        bot.solBalance = Math.max(0, (bot.solBalance ?? 0) - executedSol - FEE_EST_SOL * executedSlices); // FIX: комиссия × число срезов
        bot.tokenBalance = bot.posToken;
        buysInRow++; sellsInRow = 0; lastBuyTs = Date.now();
        lastBuyAtPrice = priceNow; lastBuyAtTs = Date.now();
        // учёт минутных лимитов происходит по каждому срезу выше
        if (trailHighPrice <= 0 || priceNow > trailHighPrice) trailHighPrice = priceNow;
      } else {
        const sellQty = executedTok > 0 ? executedTok : (amountTok ?? bot.posToken);
        bot.realized = safeAdd(bot.realized || 0, safeMultiply((priceNow || 0) - (bot.avgSol || priceNow || 0), sellQty || 0));
        bot.posToken = Math.max(0, bot.posToken - sellQty);
        bot.avgSol = bot.posToken > 0 ? bot.avgSol : 0;
        bot.solBalance = Math.max(0, (bot.solBalance ?? 0) + Math.max(0, sellQty * priceNow - FEE_EST_SOL * executedSlices)); // FIX
        bot.tokenBalance = bot.posToken;
        sellsInRow++; buysInRow = 0; lastSellTs = Date.now();
        // учёт минутных лимитов происходит по каждому срезу выше
        if (bot.posToken <= 0) trailHighPrice = 0;
      }

      bot.unrealized = safeMultiply(bot.posToken || 0, (priceNow || 0) - (bot.avgSol || priceNow || 0));
      bot.fills += executedSlices; // FIX: по количеству срезов
      bot.last =
        side === "buy"
          ? `buy ${executedSol.toFixed(6)} SOL @ slp=${ctx.slippageBps().toFixed(0)}bps`
          : `sell ${executedTok > 0 ? roundTok(executedTok, decimals) + " TOK" : "ALL"} @ slp=${ctx
              .slippageBps()
              .toFixed(0)}bps`;

      pushUpdate({
        last: bot.last,
        fills: bot.fills,
        posToken: bot.posToken,
        avgSol: bot.avgSol,
        realized: bot.realized,
        unrealized: bot.unrealized,
        solBalance: bot.solBalance,
        tokenBalance: bot.tokenBalance,
        lastError: undefined,
      });
      log("ok", `${side.toUpperCase()} executed (slices ${executedSlices})`);

      // force on-chain refresh for this bot
      await refreshOnChainBalances();
      // FIX: дать сторам подсказку обновить всё мягко
      try { ctx.afterTrade?.(); } catch {}

      // Post-trade corrective nudge towards corridor/target
      try {
        const pnow = Math.max(1e-12, ctx.price());
        const { tokVal, total, a: aNow } = alloc(pnow);
        const EPS = 0.002;
        const reserve = Math.max(MIN_KEEP_SOL, Number((risk as any).reserveSol) || 0);
        const gmin = Math.max(120, Number((risk as any).minSliceGapMs) || 200);
        const gmax = Math.max(gmin + 50, Number((risk as any).maxSliceGapMs) || 850);
        if (aNow > MAX_ALLOC + EPS) {
          const targetVal = TARGET_ALLOC * total;
          const gapTok = Math.max(0, (tokVal - targetVal) / pnow);
          const capPct = Math.min(0.5, Math.max(0.02, Number((risk as any).maxSellSliceTokPct) || 0.12));
          const maxTok = Math.min(bot.posToken * capPct, gapTok);
          const amt = roundTok(Math.max(0, maxTok), decimals);
          if (amt > 0) scheduleSell(amt, gmin, gmax);
        } else if (aNow < MIN_ALLOC - EPS) {
          const targetVal = TARGET_ALLOC * total;
          const needSol = Math.max(0, targetVal - tokVal);
          const headroom = Math.max(0, (bot.solBalance ?? 0) - (reserve + 0.0001));
          let buySol = Math.max(0, Math.min(needSol, headroom, Math.max(0.00005, Number((risk as any).maxBuySliceSol) || 0.0018)));
          if (buySol > 0.00012) {
            const delay = gmin + Math.floor(Math.random() * Math.max(1, gmax - gmin));
            setTimeout(() => { twapBuy(+buySol.toFixed(6)).catch(() => {}); }, delay);
          } else if (needSol > 0 && headroom <= 0) {
            const wantSol = Math.min(needSol * 0.3, (reserve + 0.001) - (bot.solBalance ?? 0));
            const sellTok = roundTok(Math.max(0, Math.min(bot.posToken * (Number((risk as any).maxSellSliceTokPct) || 0.12), wantSol / pnow)), decimals);
            if (sellTok > 0) scheduleSell(sellTok, gmin, gmax);
          }
        }
      } catch {}

      cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
    } catch (e: any) {
      failStreak++;
      const cool = Math.min(20000, 1000 * failStreak); // 1s → 20s
      nextRetryAt = Date.now() + cool;

      bot.lastError = e?.message || String(e);
      pushUpdate({ lastError: bot.lastError });
      warnDebounced(`net fail (${failStreak}) — ${bot.lastError}; retry in ${Math.round(cool / 1000)}s`);
    }
  }

  async function twapBuy(totalSol: number) {
    const plan = ctx.twap;
    if (!plan || plan.slices < 2 || totalSol <= 0) {
      await trade("buy", totalSol);
      return;
    }
    const per = Math.max(0, totalSol / plan.slices);
    for (let i = 0; i < plan.slices; i++) {
      await trade("buy", per);
      // mid-slice re-eval handled inside trade(); just gap here
      if (i < plan.slices - 1) await sleep(Math.max(300, plan.gapMs));
    }
  }

  // desync start a bit across bots
  setTimeout(loop, 100 + Math.floor(Math.random() * 500));
  return () => { stopped = true; };

  // lastLightRefresh now handled in store

  async function loop() {
    if (stopped || !bot.running || ctx.abortSignal?.aborted) return;
    if (pending) return;

    const now = Date.now();

    if (now < nextRetryAt) {
      if (!ctx.abortSignal?.aborted) setTimeout(loop, Math.max(200, nextRetryAt - now));
      return;
    }
    if (now < cooldownUntil) {
      if (!ctx.abortSignal?.aborted) setTimeout(loop, Math.max(50, cooldownUntil - now));
      return;
    }
    if (lossCooldownUntil && now >= lossCooldownUntil) {
      log("info", "loss cooldown ended");
      lossCooldownUntil = 0;
    }

    // Исполнить отложенную небольшую продажу (для разнообразия паттернов)
    if (deferredSell && now >= deferredSell.dueAt && bot.posToken > 0) {
      pending = true;
      try {
        // анти-churn: не выполняем случайную продажу раньше 8с после покупки
        if (now - (lastBuyTs || 0) < 8000) {
          deferredSell = null;
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
        const capPct = Math.min(0.5, Math.max(0.005, 0.035));
        const capTok = roundTok(bot.posToken * capPct, ctx.tokenDecimals());
        const qty = Math.min(capTok, Math.min(bot.posToken * 0.2, Math.max(0, deferredSell.amountTok)));
        if (qty > 0) await trade("sell", 0, { sellTokens: qty });
      } catch {}
      deferredSell = null;
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }

    pending = true;
    try {
      // periodic light on-chain refresh (keeps UI in sync even without trades)
      if (ctx.shouldLightRefresh?.(10000)) {
        await refreshOnChainBalances();
        ctx.setLightRefresh?.();
      }

      if (ctx.isAiPaused && ctx.isAiPaused()) {
        bot.last = "ai:off";
        pushUpdate({ last: bot.last });
        pending = false;
        const jitter = 200 + Math.floor(Math.random() * 300);
        return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
      }

      const p = Math.max(1e-12, ctx.price());
      // update rolling price history (dev for mean/stdev)
      priceHist.push(p);
      if (priceHist.length > 120) priceHist.shift();
      const fast = ctx.changeFast?.(12) ?? 0;
      const ch1m = ctx.change1m();

      const { a: allocTok, total } = alloc(p);

      // Риск: защитный режим при большой просадке
      const portfolioNow = bot.solBalance + bot.posToken * p;
      if (baselineValue === 0) baselineValue = portfolioNow;
      let risk: any = { maxImpact: 0.010, maxDrawdown: 0.12, reserveSol: 0.0060, maxNotionalPerMin: 0.0008, maxBuysPerMin: 1, maxSellsPerMin: 4, lossThrPct: 0.003, lossWindowMs: 30000, lossCooldownMs: 180000, maxBuySliceSol: 0.00035, maxSellSliceTokPct: 0.035, minSliceGapMs: 600, maxSliceGapMs: 1800 };
      try { const r = (ctx as any).getRisk?.(); if (r) risk = r; } catch {}
      const protect = portfolioNow < baselineValue * (1 - Math.min(MAX_TOTAL_DRAWDOWN, risk.maxDrawdown));

      // Bad-buy cooldown: если после последней покупки цена упала сильнее порога в окне — охлаждение на lossCooldownMs
      try {
        const thr = Math.max(0, Number(risk.lossThrPct) || 0);
        const win = Math.max(0, Number(risk.lossWindowMs) || 0);
        const cool = Math.max(0, Number(risk.lossCooldownMs) || 0);
        const since = now - (lastBuyAtTs || 0);
        if (lastBuyAtPrice && win > 0 && since <= win) {
          const drop = Math.max(0, (lastBuyAtPrice - p) / Math.max(1e-12, lastBuyAtPrice));
          if (drop >= thr) {
            const until = now + cool;
            if (until > lossCooldownUntil) {
              lossCooldownUntil = until;
              log("warn", `start cooldown: drop ${(drop*100).toFixed(2)}% ≥ ${(thr*100).toFixed(2)}%, ${Math.round(cool/1000)}s`);
            }
            // сбросим маркеры для повторной оценки после окна
            lastBuyAtPrice = null;
          }
        } else if (win > 0 && since > win) {
          lastBuyAtPrice = null;
        }
      } catch {}

      // Обновляем trailing high для momentum/общего стопа
      if (bot.posToken > 0) trailHighPrice = Math.max(trailHighPrice || p, p); else trailHighPrice = 0;

      // Считываем шаг исполнения и модифицируем под стратегию
      let step = { minSol: 0.0002, maxSol: 0.0008, slicesMax: 4, jitterPct: 0.25 };
      try { const s = (ctx as any).getTradeStep?.(); if (s) step = s; } catch {}
      const caps = capsForStrategy(bot.strategy as InternalStrategy);
      step.minSol = +(step.minSol * caps.stepMulMin).toFixed(6);
      step.maxSol = +(step.maxSol * caps.stepMulMax).toFixed(6);
      // Dynamic step sizing: shrink on high impact/vol
      const volScoreForStep = Math.max(Math.abs(ctx.changeFast?.(8) || 0), Math.abs(ctx.change1m?.() || 0));
      if (volScoreForStep > 0.006) {
        step.maxSol = +(step.maxSol * 0.8).toFixed(6);
      }
      const pickStep = () => {
        const base = step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
        const jitter = 1 + (Math.random()*2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
        return Math.max(0.00005, +(base * jitter).toFixed(6));
      };

      const reserve = Math.max(MIN_KEEP_SOL, risk.reserveSol || 0.0009);
      const baseSize = Math.max(
        step.minSol,
        Math.min(bot.budgetSol || ctx.tradeSize() || step.maxSol, bot.solBalance - (reserve + step.minSol))
      );
      const haveSol = bot.solBalance > reserve + 0.00015;
      const eps = 0.005; // гистерезис коридора

      // ======= emergency: нет SOL для комиссий/ребаланса — продадим немного токена сразу
      if (bot.posToken > 0 && bot.solBalance < reserve) {
        const needSol = Math.max(0, (reserve + 0.0015) - bot.solBalance);
        const tokToSell = roundTok(Math.min(bot.posToken * 0.22, needSol / Math.max(1e-12, p)), ctx.tokenDecimals());
        if (tokToSell > 0) {
          await trade("sell", 0, { sellTokens: tokToSell });
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      /* ======= pre-strategy auto-rebalance ======= */
      if (bot.posToken > 0 && allocTok > MAX_ALLOC + eps) {
        const desiredTokVal = TARGET_ALLOC * total;
        const currentTokVal = bot.posToken * p;
        const excessVal = Math.max(0, currentTokVal - desiredTokVal);
        // если сильно вышли за коридор — продаём агрессивнее к цели
        const over = allocTok - MAX_ALLOC;
        const factor = over > 0.03 ? 1.0 : over > 0.015 ? 0.75 : 0.5;
        const tokToSell = Math.min(
          bot.posToken,
          roundTok(Math.max(bot.posToken * 0.12, (excessVal * factor) / p), ctx.tokenDecimals())
        );
        if (tokToSell > 0) {
          await trade("sell", 0, { sellTokens: tokToSell });
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      if (!protect && allocTok < MIN_ALLOC - eps) {
        // если SOL хватает — покупаем; иначе сначала продадим кусок, чтобы профинансировать покупку
        if (!haveSol) {
          const targetVal = TARGET_ALLOC * total;
          const needVal = Math.max(0, targetVal - bot.posToken * p);
          // продадим небольшой кусок, чтобы получить SOL на будущие покупки
          const tokToSell = roundTok(Math.max(bot.posToken * 0.08, Math.min(bot.posToken * 0.2, (needVal * 0.25) / p)), ctx.tokenDecimals());
          if (tokToSell > 0) {
            await trade("sell", 0, { sellTokens: tokToSell });
            pending = false;
            const jitter = 200 + Math.floor(Math.random() * 300);
            return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
          }
        }
        // если SOL есть — покупаем к цели
        const targetVal = TARGET_ALLOC * total;
        const needVal = Math.max(0, targetVal - bot.posToken * p);
        const buySol = Math.max(0, Math.min(Math.min(baseSize, pickStep()), needVal));
        if (buySol > 0.00012) {
          await twapBuy(buySol);
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      /* ================== strategies ================== */
      let did = false;

      const strat = (bot.strategy as InternalStrategy);
      switch (strat) {
        case "trend": {
          // micro anti-chase: if already bought twice and no new highs while accelerating — cool down
          if (buysInRow >= 2 && fast > 0.001 && trailHighPrice > 0 && p < trailHighPrice * 0.9995) {
            const pause = bot.speedMs * (1 + Math.random());
            cooldownUntil = Date.now() + Math.max(600, Math.min(2400, pause));
            log("info", `micro-cooldown ${(Math.round(pause))}ms to avoid chasing`);
            break;
          }

          // Entry: momentum add on positive slope + 1m change, headroom to maxAlloc, smaller of base/pick
          if (!protect && haveSol && fast > 0 && ch1m > 0.001 && allocTok < MAX_ALLOC) {
            const headroomToMax = Math.max(0, MAX_ALLOC * total - bot.posToken * p);
            const size = Math.min(Math.min(baseSize, pickStep()), headroomToMax);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
          // Profit take: >= +7% from avg → shave 8–18%
          if (bot.posToken > 0 && bot.avgSol > 0) {
            const r = (p - bot.avgSol) / Math.max(1e-9, bot.avgSol);
            if (r >= 0.07) {
              const pct = 0.08 + Math.random() * 0.10;
              const part = roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
              if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; break; }
            }
          }
          // Trailing stop: drop from recent high >= 0.9% → shave 6–12%
          if (!did && bot.posToken > 0 && trailHighPrice > 0) {
            const dd = (p - trailHighPrice) / Math.max(1e-9, trailHighPrice);
            if (dd <= -0.009) {
              const pct = 0.06 + Math.random() * 0.06;
              const part = roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
              if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; break; }
            }
          }
          // Corridor pressure: reduce toward target if above max
          if (!did && (allocTok > MAX_ALLOC || protect)) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.10, (excessVal * 0.5) / p), ctx.tokenDecimals())
            );
            if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; }
          }
          break;
        }

        case "revert": {
          // compute rolling mean/stdev from last N prices
          const N = Math.min(90, priceHist.length);
          const M = Math.max(12, Math.min(36, N));
          const slice = priceHist.slice(-M);
          const mean = slice.reduce((s, x) => s + x, 0) / Math.max(1, slice.length);
          const sd = Math.sqrt(slice.reduce((s, x) => s + Math.pow(x - mean, 2), 0) / Math.max(1, slice.length));
          const dev = mean > 0 ? (p - mean) / mean : 0;

          // Entry: dip below mean by ≥0.7% with negative fast momentum, not in cooldown
          if (!protect && haveSol && allocTok < (MAX_ALLOC - 0.001) && fast < 0 && dev <= -0.007 && Date.now() >= lossCooldownUntil) {
            const headroomToMax = Math.max(0, MAX_ALLOC * total - bot.posToken * p);
            const size = Math.min(Math.min(baseSize, pickStep()), headroomToMax);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }

          // Shave on mean touch or small profit ≥1.2%
          const smallProfit = bot.avgSol > 0 ? (p - bot.avgSol) / Math.max(1e-9, bot.avgSol) >= 0.012 : false;
          const nearMean = Math.abs(dev) <= 0.0015; // within 0.15% of mean
          if (!did && bot.posToken > 0 && (smallProfit || nearMean)) {
            const pct = 0.08 + Math.random() * 0.07;
            const part = roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
            if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; }
          }
          // Fade spikes: if deviation flips high ≥ +0.8%
          if (!did && bot.posToken > 0 && dev >= 0.008) {
            const pct = 0.08 + Math.random() * 0.07;
            const part = roundTok(Math.max(0, bot.posToken * pct), ctx.tokenDecimals());
            if (part > 0) { await trade("sell", 0, { sellTokens: part }); did = true; }
          }
          // deferred small sell after multiple buys to prevent creep
          if (!did && buysInRow > 0 && bot.posToken > 0) {
            const planned = roundTok(Math.max(bot.posToken * 0.04, bot.posToken * 0.03 + Math.random() * bot.posToken * 0.03), ctx.tokenDecimals());
            if (!deferredSell && planned > 0) scheduleSell(planned, 1600, 3400);
          }
          break;
        }

        case "scalper": {
          if (!protect && haveSol && Math.abs(fast) > 0.0018 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.12) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()), headroomVal);
            if (size > 0.0001) { await twapBuy(size); did = true; break; }
          }
          if (wantToSell(bot, p, 120, 55) || allocTok > MAX_ALLOC || protect) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.12, (excessVal * 0.45) / p), ctx.tokenDecimals())
            );
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          } else if (bot.posToken > 0 && buysInRow >= 2) {
            const shave = roundTok(Math.max(bot.posToken * 0.06, bot.posToken * Math.random() * 0.08), ctx.tokenDecimals());
            if (shave > 0) { await trade("sell", 0, { sellTokens: shave }); did = true; }
          }
          break;
        }

        case "momentum": { // усиливает покупки при ускорении, trailing-stop продажи
          if (!protect && haveSol && (fast > 0.001 || ch1m > 0.002) && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()*1.2), headroomVal);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
          // trailing stop: падение от пика >0.9% → частичная продажа
          if (bot.posToken > 0 && trailHighPrice > 0) {
            const dd = (p - trailHighPrice) / Math.max(1e-9, trailHighPrice);
            if (dd < -0.009) {
              const part = roundTok(Math.max(bot.posToken * 0.1, bot.posToken * 0.06 + Math.random() * 0.06), ctx.tokenDecimals());
              await trade("sell", 0, { sellTokens: part });
              did = true;
              break;
            }
          }
          if (wantToSell(bot, p, 150, 80) || allocTok > MAX_ALLOC || protect) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(bot.posToken, roundTok(Math.max(bot.posToken * 0.18, (excessVal * 0.55) / p), ctx.tokenDecimals()));
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "range": { // покупает у нижней кромки канала, продаёт у верхней
          const mid = bot.avgSol || p;
          const dev = (p - mid) / Math.max(1e-9, mid);
          if (!protect && haveSol && dev < -0.01 && allocTok < MAX_ALLOC) {
            const size = Math.min(Math.max(baseSize, pickStep()), (TARGET_ALLOC + 0.1) * total);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
          if (dev > 0.012 || allocTok > MAX_ALLOC || protect) {
            const part = roundTok(Math.max(bot.posToken * 0.12, (bot.posToken * dev) / 2), ctx.tokenDecimals());
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "maker": { // мелкие частые сделки вокруг текущей цены
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
        // универсальное бритьё позиции: после 2+ покупок подряд или по таймеру — без рандома
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
      bot.lastError = e?.message || String(e);
      pushUpdate({ lastError: bot.lastError });
      warnDebounced(String(e?.message || e));
    } finally {
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      if (!stopped && !ctx.abortSignal?.aborted) {
        setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
      }
    }
  }
}
