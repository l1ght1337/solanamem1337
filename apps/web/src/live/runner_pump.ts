import {
  Connection,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getSPLBalance } from "../utils/solana";
import { scheduleFetch } from "../utils/network";
import { getJupiterQuote, WSOL } from "../utils/jupiter";

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

  onLog: (level: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
  afterTrade?: () => void;

  // из стора (передаётся, см. startBot)
  getAlloc?: () => { target: number; min: number; max: number };
  getTradeStep?: () => { minSol: number; maxSol: number; slicesMax: number; jitterPct: number };
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
  };
};

/* ─────────────────────── Net bases & utilities ─────────────────────── */
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const ALT_PUMP = ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, "");
const PUMP_BASES = [API_BASE ? `${API_BASE}/x/pump` : "", ALT_PUMP, "https://pumpportal.fun"].filter(Boolean);

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
      await new Promise((r) => setTimeout(r, jitter));
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

const enqueueTradeBuild: <T>(fn: () => Promise<T>) => Promise<T> =
  (window as any).__tradeQ || ((window as any).__tradeQ = makeQueue(3, 150));

function withTimeout<T>(p: Promise<T>, ms = 20_000): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fetch timeout")), ms);
    p.then(
      (v) => { clearTimeout(t); resolve(v); },
      (e) => { clearTimeout(t); reject(e); }
    );
  });
}

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
      { path: "/api/trade-local", binary: true },
      { path: "/api/trade", binary: false },
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
const FEE_EST_SOL = 0.00002;
const MIN_KEEP_SOL = 0.0006;

// Цель/коридор (значения обновляются из UI/стоя)
let TARGET_ALLOC = 0.70;
let MAX_ALLOC = 0.85;
let MIN_ALLOC = 0.60;

const MAX_SINGLE_TRADE_IMPACT = 0.20;
const MAX_TOTAL_DRAWDOWN = 0.30;
const MAX_ROUNDTRIP_LOSS = 0.01;

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

  // backoff
  let failStreak = 0;
  let nextRetryAt = 0;
  let lastWarnTs = 0;

  // Базовый пик портфеля для защиты
  let baselineValue = 0;

  // Поведенческие счётчики
  let buysInRow = 0;
  let sellsInRow = 0;
  let lastBuyTs = 0;
  let lastSellTs = 0;
  let trailHighPrice = 0;
  let deferredSell: { dueAt: number; amountTok: number } | null = null;

  // Мониторинг потерь после покупок → охлаждение
  let lastBuyAtPrice: number | null = null;
  let lastBuyAtTs = 0;
  let lossCooldownUntil = 0;

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
      default:         return { buySlice: 0.0012, sellPct: 0.10, stepMulMin: 1.0, stepMulMax: 1.0 } as any;
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

  // минутные ограничения
  let minWindowStart = Date.now();
  let buysThisMin = 0;
  let sellsThisMin = 0;
  let notionalThisMin = 0;

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
    } catch {}
  }

  async function trade(
    side: "buy" | "sell",
    sizeSol: number,
    opts?: { sellTokens?: number }
  ) {
    // риск-профиль
    let risk = { maxImpact: 0.1, maxDrawdown: 0.25, reserveSol: 0.0012, maxNotionalPerMin: 0.02, maxBuysPerMin: 6, maxSellsPerMin: 10, lossThrPct: 0.008, lossWindowMs: 20000, lossCooldownMs: 20000, maxBuySliceSol: 0.0018, maxSellSliceTokPct: 0.12, minSliceGapMs: 200, maxSliceGapMs: 850 };
    try { const r = (ctx as any).getRisk?.(); if (r) risk = r; } catch {}

    // актуальные аллокации из UI
    try {
      const allocUI = (ctx as any).getAlloc?.();
      if (allocUI && typeof allocUI.target === 'number') {
        TARGET_ALLOC = Math.min(0.95, Math.max(0.05, allocUI.target));
        MIN_ALLOC = Math.min(TARGET_ALLOC, Math.max(0.05, allocUI.min ?? 0.6));
        MAX_ALLOC = Math.max(TARGET_ALLOC, Math.min(0.98, allocUI.max ?? 0.85));
      }
    } catch {}

    // форма шага
    let step = { minSol: 0.0003, maxSol: 0.003, slicesMax: 3, jitterPct: 0.18 };
    try { const s = (ctx as any).getTradeStep?.(); if (s) step = s; } catch {}
    const pickStep = () => {
      const base = step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
      const jitter = 1 + (Math.random()*2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
      return Math.max(0.00005, +(base * jitter).toFixed(6));
    };
    const kp = ctx.keypair();
    const decimals = ctx.tokenDecimals();
    const priceNow = Math.max(1e-12, ctx.price());

    const amountTok =
      side === "sell" && opts?.sellTokens ? roundTok(opts.sellTokens, decimals) : undefined;

    // ✨ Жёсткий кламп по коридору ещё ДО сборки транзы
    try {
      const { total } = alloc(priceNow);
      if (side === "buy" && sizeSol > 0) {
        const currTokVal = bot.posToken * priceNow;
        const maxBuyVal = Math.max(0, MAX_ALLOC * total - currTokVal);
        const clamped = Math.min(sizeSol, maxBuyVal);
        if (clamped <= 0.00012) return;
        sizeSol = +clamped.toFixed(6);
      } else if (side === "sell") {
        const minTokAfter = Math.max(0, (MIN_ALLOC * total) / Math.max(1e-12, priceNow));
        const maxSellTok = Math.max(0, bot.posToken - minTokAfter);
        if (opts?.sellTokens) {
          const newAmt = Math.min(opts.sellTokens, maxSellTok);
          if (newAmt <= 0) return;
          (opts as any).sellTokens = newAmt;
        } else if ((amountTok ?? bot.posToken) > 0) {
          const capped = Math.min((amountTok ?? bot.posToken), maxSellTok);
          if (capped <= 0) return;
          (opts as any) = { ...(opts || {}), sellTokens: capped };
        }
      }
    } catch {}

    if (side === "buy" && sizeSol <= 0) return;
    if (side === "sell" && (amountTok ?? bot.posToken) <= 0) return;

    // минутные лимиты + охлаждение после потерь
    const nowTs = Date.now();
    if (nowTs - minWindowStart >= 60_000) { minWindowStart = nowTs; buysThisMin = 0; sellsThisMin = 0; notionalThisMin = 0; }
    if (side === 'buy') {
      if (nowTs < lossCooldownUntil) return;
      if (buysThisMin >= risk.maxBuysPerMin) return;
      if (notionalThisMin + sizeSol > risk.maxNotionalPerMin) return;
    } else {
      if (sellsThisMin >= risk.maxSellsPerMin) return;
    }

    const payload =
      side === "buy"
        ? {
            publicKey: kp.publicKey.toBase58(),
            action: "buy",
            mint: ctx.mint,
            denominatedInSol: "true",
            amount: sizeSol,
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          }
        : {
            publicKey: kp.publicKey.toBase58(),
            action: "sell",
            mint: ctx.mint,
            denominatedInSol: "false",
            amount: amountTok ?? roundTok(bot.posToken, decimals),
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          };

    try {
      // sanity по котировкам
      if (side === 'buy') {
        const pay = Math.round(Math.max(0.00005, sizeSol || pickStep()) * 1e9);
        try {
          const q = await getJupiterQuote({ inputMint: WSOL, outputMint: ctx.mint, amount: pay });
          const fairOut = (pay / 1e9) / priceNow;
          const out = Number(q.outAmount || 0) / Math.pow(10, decimals);
          const maxImpact = Math.min(MAX_SINGLE_TRADE_IMPACT, (ctx.getRisk?.() || ({} as any)).maxImpact ?? 0.1);
          if (fairOut > 0 && out < fairOut * (1 - maxImpact)) {
            warnDebounced(`skip BUY: impact too high (${((1 - out/fairOut)*100).toFixed(1)}%)`);
            return;
          }
          if (out > 0) {
            try {
              const backRaw = Math.max(1, Math.round(out * Math.pow(10, decimals)));
              const qb = await getJupiterQuote({ inputMint: ctx.mint, outputMint: WSOL, amount: backRaw });
              const backSol = Number(qb.outAmount || 0) / 1e9;
              const lossPct = Math.max(0, 1 - backSol / Math.max(1e-12, (pay / 1e9)));
              if (isFinite(lossPct) && lossPct > MAX_ROUNDTRIP_LOSS) {
                warnDebounced(`skip BUY: roundtrip loss ${(lossPct*100).toFixed(1)}%`);
                return;
              }
            } catch {}
          }
        } catch {}
      } else {
        const qty = amountTok ?? bot.posToken;
        const raw = Math.round(qty * Math.pow(10, decimals));
        try {
          const q = await getJupiterQuote({ inputMint: ctx.mint, outputMint: WSOL, amount: raw });
          const fairOutSol = qty * priceNow;
          const outSol = Number(q.outAmount || 0) / 1e9;
          const maxImpact = Math.min(MAX_SINGLE_TRADE_IMPACT, (ctx.getRisk?.() || ({} as any)).maxImpact ?? 0.1);
          if (fairOutSol > 0 && outSol < fairOutSol * (1 - maxImpact)) {
            warnDebounced(`skip SELL: impact too high (${((1 - outSol/fairOutSol)*100).toFixed(1)}%)`);
            return;
          }
        } catch {}
      }

      const caps = capsForStrategy(bot.strategy as InternalStrategy);

      let remainingSol = side === 'buy' ? (sizeSol || pickStep()) : 0;
      let remainingTok = side === 'sell' ? (amountTok ?? bot.posToken) : 0;
      const risk = (ctx.getRisk?.() as any) || {};
      const maxBuyPerSlice = Math.max(0.00005, Math.min((risk.maxBuySliceSol ?? 0.0018), caps.buySlice));
      const maxSellPct = Math.min(0.5, Math.max(0.02, Math.min((risk.maxSellSliceTokPct ?? 0.12), caps.sellPct)));
      const maxSellPerSlice = side === 'sell' ? roundTok((bot.posToken || 0) * maxSellPct, decimals) : 0;

      let step = (ctx.getTradeStep?.() || { minSol: 0.0003, maxSol: 0.003, slicesMax: 3, jitterPct: 0.18 });
      let slices = Math.max(1, Math.min(step.slicesMax, Math.round(1 + Math.random() * (step.slicesMax - 1))));
      if (side === 'sell' && maxSellPerSlice > 0) {
        const need = Math.ceil(remainingTok / Math.max(1e-12, maxSellPerSlice));
        slices = Math.min(step.slicesMax, Math.max(slices, need));
      }

      let executedSol = 0;
      let executedTok = 0;
      let executedSlices = 0;

      for (let si = 0; si < slices; si++) {
        let pl = payload as any;
        if (side === 'buy') {
          const pay = Math.min(maxBuyPerSlice, remainingSol);
          if (pay <= 0.000049) break;
          pl = { ...payload, amount: +pay.toFixed(6) };
          remainingSol = Math.max(0, +(remainingSol - pay).toFixed(6));
        } else {
          const perTok = maxSellPerSlice > 0 ? Math.min(maxSellPerSlice, remainingTok) : remainingTok / Math.max(1, (slices - si));
          const qty = roundTok(Math.max(0, perTok), decimals);
          if (qty <= 0) break;
          pl = { ...payload, amount: qty };
          remainingTok = Math.max(0, remainingTok - qty);
        }

        const vtx = await buildTradeTxPumpPortal(pl);
        vtx.sign([kp]);
        const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 4 });
        await connection.confirmTransaction(sig, "confirmed");

        executedSlices++;
        if (side === 'buy') executedSol += pl.amount;
        else executedTok += pl.amount;

        if (si < slices-1 && (side === 'buy' ? remainingSol > 0 : remainingTok > 0)) {
          const gmin = Math.max(120, (risk.minSliceGapMs || 200));
          const gmax = Math.max(gmin+50, (risk.maxSliceGapMs || 850));
          const gap = gmin + Math.floor(Math.random() * (gmax - gmin));
          await sleep(gap);
        }
      }

      if (executedSlices === 0) throw new Error("no slices executed");

      // success → reset backoff
      failStreak = 0;
      nextRetryAt = 0;

      if (side === "buy") {
        const qty = executedSol / priceNow;
        const newPos = bot.posToken + qty;
        bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + executedSol) / newPos : priceNow;
        bot.posToken = newPos;
        bot.solBalance = Math.max(0, (bot.solBalance ?? 0) - executedSol - FEE_EST_SOL * executedSlices);
        bot.tokenBalance = bot.posToken;
        buysInRow++; sellsInRow = 0; lastBuyTs = Date.now();
        // ✨ запоминаем последнюю покупку для окна потерь
        lastBuyAtPrice = priceNow;
        lastBuyAtTs = Date.now();

        buysThisMin++;
        notionalThisMin = +(notionalThisMin + executedSol).toFixed(6);
        if (trailHighPrice <= 0 || priceNow > trailHighPrice) trailHighPrice = priceNow;
      } else {
        const sellQty = executedTok > 0 ? executedTok : (amountTok ?? bot.posToken);
        bot.realized += (priceNow - (bot.avgSol || priceNow)) * sellQty;
        bot.posToken = Math.max(0, bot.posToken - sellQty);
        bot.avgSol = bot.posToken > 0 ? bot.avgSol : 0;
        bot.solBalance = Math.max(0, (bot.solBalance ?? 0) + Math.max(0, sellQty * priceNow - FEE_EST_SOL * executedSlices));
        bot.tokenBalance = bot.posToken;
        sellsInRow++; buysInRow = 0; lastSellTs = Date.now();
        sellsThisMin++;
        if (bot.posToken <= 0) trailHighPrice = 0;
      }

      bot.unrealized = bot.posToken * (priceNow - (bot.avgSol || priceNow));
      bot.fills += executedSlices;
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
      log("ok", `${side.toUpperCase()} executed`);

      await refreshOnChainBalances();
      try { ctx.afterTrade?.(); } catch {}

      cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
    } catch (e: any) {
      failStreak++;
      const cool = Math.min(20000, 1000 * failStreak);
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
      if (i < plan.slices - 1) await sleep(Math.max(300, plan.gapMs));
    }
  }

  setTimeout(loop, 100 + Math.floor(Math.random() * 500));
  return () => { stopped = true; };

  let lastLightRefresh = 0;

  async function loop() {
    if (stopped || !bot.running) return;
    if (pending) return;

    const now = Date.now();

    if (now < nextRetryAt) {
      setTimeout(loop, Math.max(200, nextRetryAt - now));
      return;
    }
    if (now < cooldownUntil) {
      setTimeout(loop, Math.max(50, cooldownUntil - now));
      return;
    }

    // ✨ охлаждение при провале после покупки (уменьшает усреднение в тренде вниз)
    try {
      const risk = (ctx.getRisk?.() as any) || {};
      if (lastBuyAtPrice && lastBuyAtTs && now - lastBuyAtTs <= (risk.lossWindowMs ?? 20000)) {
        const p = Math.max(1e-12, ctx.price());
        const drop = (p - lastBuyAtPrice) / Math.max(1e-9, lastBuyAtPrice);
        if (drop <= -(risk.lossThrPct ?? 0.008)) {
          lossCooldownUntil = now + (risk.lossCooldownMs ?? 20000);
          lastBuyAtPrice = null; // сбрасываем окно
          warnDebounced(`cooldown after loss ${Math.round((risk.lossCooldownMs ?? 20000)/1000)}s`);
        }
      }
    } catch {}

    // отложенная продажа
    if (deferredSell && now >= deferredSell.dueAt && bot.posToken > 0) {
      pending = true;
      try {
        const qty = Math.min(bot.posToken * 0.2, Math.max(0, deferredSell.amountTok));
        if (qty > 0) await trade("sell", 0, { sellTokens: qty });
      } catch {}
      deferredSell = null;
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }

    pending = true;
    try {
      // периодический лёгкий refresh
      if (now - lastLightRefresh > 10000) {
        await refreshOnChainBalances();
        lastLightRefresh = now;
      }

      if (ctx.isAiPaused && ctx.isAiPaused()) {
        bot.last = "ai:off";
        pushUpdate({ last: bot.last });
        pending = false;
        const jitter = 200 + Math.floor(Math.random() * 300);
        return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
      }

      const p = Math.max(1e-12, ctx.price());
      const fast = ctx.changeFast?.(12) ?? 0;
      const ch1m = ctx.change1m();

      const { a: allocTok, total } = alloc(p);

      // trailing high для stop в momentum
      if (bot.posToken > 0) trailHighPrice = Math.max(trailHighPrice || p, p); else trailHighPrice = 0;

      // форма шага + модификаторы по стратегии
      let step = (ctx.getTradeStep?.() || { minSol: 0.0003, maxSol: 0.003, slicesMax: 3, jitterPct: 0.18 });
      const caps = capsForStrategy(bot.strategy as InternalStrategy);
      step.minSol = +(step.minSol * caps.stepMulMin).toFixed(6);
      step.maxSol = +(step.maxSol * caps.stepMulMax).toFixed(6);
      const pickStep = () => {
        const base = step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
        const jitter = 1 + (Math.random()*2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
        return Math.max(0.00005, +(base * jitter).toFixed(6));
      };

      const risk = (ctx.getRisk?.() as any) || {};
      const protect = (() => {
        const portfolioNow = bot.solBalance + bot.posToken * p;
        if (baselineValue === 0) baselineValue = portfolioNow;
        // подтягиваем baseline к пикам, но не снижаем — мягкая защита
        baselineValue = Math.max(baselineValue, portfolioNow);
        return portfolioNow < baselineValue * (1 - Math.min(MAX_TOTAL_DRAWDOWN, risk.maxDrawdown ?? 0.25));
      })();

      const reserve = Math.max(MIN_KEEP_SOL, risk.reserveSol || 0.0009);
      const baseSize = Math.max(
        step.minSol,
        Math.min(bot.budgetSol || ctx.tradeSize() || step.maxSol, bot.solBalance - (reserve + step.minSol))
      );
      const haveSol = bot.solBalance > reserve + 0.00015;
      const eps = 0.003; // чуть уже гистерезис — держим коридор

      // аварийная продажа при нехватке SOL
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

      /* ======= Жёсткий auto-rebalance к границам коридора ======= */
      if (bot.posToken > 0 && allocTok > MAX_ALLOC + eps) {
        const desiredTokVal = Math.min(TARGET_ALLOC, MAX_ALLOC) * total;
        const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
        const sellTok = roundTok(excessVal / p, ctx.tokenDecimals());
        if (sellTok > 0) {
          await trade("sell", 0, { sellTokens: sellTok });
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      if (!protect && allocTok < MIN_ALLOC - eps) {
        if (!haveSol) {
          const targetVal = Math.max(MIN_ALLOC, TARGET_ALLOC) * total;
          const needVal = Math.max(0, targetVal - bot.posToken * p);
          const tokToSell = roundTok(Math.max(bot.posToken * 0.06, Math.min(bot.posToken * 0.18, (needVal * 0.25) / p)), ctx.tokenDecimals());
          if (tokToSell > 0) {
            await trade("sell", 0, { sellTokens: tokToSell });
            pending = false;
            const jitter = 200 + Math.floor(Math.random() * 300);
            return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
          }
        }
        const targetVal = Math.max(MIN_ALLOC, TARGET_ALLOC) * total;
        const needVal = Math.max(0, targetVal - bot.posToken * p);
        const buySol = Math.max(0, Math.min(Math.max(baseSize, pickStep()), needVal));
        if (buySol > 0.00012) {
          await twapBuy(buySol);
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      /* ================== стратегии ================== */
      let did = false;
      const strat = (bot.strategy as InternalStrategy);

      switch (strat) {
        case "trend": {
          if (!protect && haveSol && (fast > 0.0006 || ch1m > 0.001) && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.12) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()), headroomVal);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
          if (wantToSell(bot, p, 700, 400) || allocTok > MAX_ALLOC || protect) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.15, (excessVal * 0.5) / p), ctx.tokenDecimals())
            );
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "revert": {
          if (!protect && haveSol && (fast < -0.0009 || ch1m < -0.0012) && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.1) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()), headroomVal);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
          if (wantToSell(bot, p, 120, 60) || allocTok > MAX_ALLOC || protect) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.15, (excessVal * 0.5) / p), ctx.tokenDecimals())
            );
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          } else if (buysInRow > 0 && bot.posToken > 0) {
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

        case "momentum": {
          if (!protect && haveSol && (fast > 0.001 || ch1m > 0.002) && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(Math.max(baseSize, pickStep()*1.2), headroomVal);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
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

        case "range": {
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
        bot.unrealized = bot.posToken * (p - (bot.avgSol || p));
        pushUpdate({ last: bot.last, unrealized: bot.unrealized, fills: bot.fills });
      }
    } catch (e: any) {
      bot.lastError = e?.message || String(e);
      pushUpdate({ lastError: bot.lastError });
      warnDebounced(String(e?.message || e));
    } finally {
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      if (!stopped) setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }
  }
}
