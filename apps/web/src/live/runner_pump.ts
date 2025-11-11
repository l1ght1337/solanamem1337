// apps/web/src/live/runner_pump.ts
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
  shouldLogStop?: () => boolean;

  onLog: (l: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
  afterTrade?: (reason?: "trade" | "idle") => void;
    onFailStreak?: (count: number) => void;

  // из store.startBot мы пробрасываем:
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
    // доп. поле — “no loss” режим: продаем только ≥ avg* (1 + floor)
    noLossFloorBps?: number; // например 0 … 30 (0…0.3%)
  };
};

/* ─────────────────────── Net bases & utilities ─────────────────────── */
// prefer your backend → custom pump API → public pump portal
const API_BASE = ((import.meta as any).env?.VITE_API_BASE || "").replace(
  /\/+$/,
  "",
);
const ALT_PUMP = ((import.meta as any).env?.VITE_PUMP_API || "").replace(
  /\/+$/,
  "",
);
const PUMP_BASES = [
  API_BASE ? `${API_BASE}/x/pump` : "",
  ALT_PUMP,
  "https://pumpportal.fun",
].filter(Boolean);

const PF_BASE_SOL = Math.max(
  0.000006,
  Number((import.meta as any).env?.VITE_PRIORITY_FEE_BASE ?? 0.000008),
);
const PF_MAX_SOL = Math.max(
  PF_BASE_SOL,
  Number((import.meta as any).env?.VITE_PRIORITY_FEE_MAX ?? 0.00012),
);

type Job<T> = () => Promise<T>;
function makeQueue(concurrency = 8, baseGapMs = 60) {
  const q: Array<{
    job: Job<any>;
    res: (v: any) => void;
    rej: (e: any) => void;
  }> = [];
  let running = 0;
  async function runNext() {
    if (running >= concurrency) return;
    const it = q.shift();
    if (!it) return;
    running++;
    try {
      const jitter = baseGapMs + Math.floor(Math.random() * baseGapMs);
      const out = await it.job();
      await new Promise((r) => setTimeout(r, jitter));
      it.res(out);
    } catch (e) {
      it.rej(e);
    } finally {
      running--;
      runNext();
    }
  }
  return <T>(job: Job<T>) =>
    new Promise<T>((res, rej) => {
      q.push({ job, res, rej });
      runNext();
    });
}
const enqueueTradeBuild =
  (window as any).__tradeQ || ((window as any).__tradeQ = makeQueue());

let stickyBaseIdx = -1;
async function fetchFirstOk(path: string, init: RequestInit = {}, retries = 2) {
  const order = [...PUMP_BASES.keys()];
  if (stickyBaseIdx >= 0) {
    const i = order.indexOf(stickyBaseIdx);
    if (i > 0) {
      order.splice(i, 1);
      order.unshift(stickyBaseIdx);
    }
  }
  let lastErr: any;
  for (const idx of order) {
    const base = PUMP_BASES[idx];
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let a = 0; a <= retries; a++) {
      const backoff = a === 0 ? 0 : 250 * a + Math.floor(Math.random() * 250);
      if (backoff) await new Promise((r) => setTimeout(r, backoff));
      try {
        const r = await scheduleFetch(
          url,
          { ...(init as any), timeoutMs: 20_000, tries: 1 },
          "pump",
        );
        if (r.ok) {
          stickyBaseIdx = idx;
          return r;
        }
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

async function buildTradeTxPump(
  payload: Record<string, any>,
): Promise<VersionedTransaction> {
  return enqueueTradeBuild(async () => {
    const tries: Array<{ path: string; bin: boolean }> = [
      { path: "/api/trade-local", bin: true },
      { path: "/api/trade", bin: false },
    ];
    let lastErr: any;
    for (const t of tries) {
      try {
        const r = await fetchFirstOk(t.path, {
          method: "POST",
          headers: {
            "Content-Type": "application/json",
            Accept: "application/json",
          },
          body: JSON.stringify(payload),
        });
        const ct = r.headers.get("content-type") || "";
        if (t.bin && /octet-stream/.test(ct)) {
          const raw = new Uint8Array(await r.arrayBuffer());
          return VersionedTransaction.deserialize(raw);
        }
        const j = await r.json().catch(() => ({}) as any);
        const b64 =
          j?.serializedTransaction || j?.tx || j?.transaction || j?.vtx;
        if (!b64) throw new Error("no serialized transaction in response");
        const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
        return VersionedTransaction.deserialize(raw);
      } catch (e) {
        lastErr = e;
      }
    }
    throw lastErr || new Error("trade build failed");
  });
}

/* ─────────────────── Helpers / risk / math ─────────────────── */
const FEE_EST_SOL = 0.00002; // ~20k lamports
const MIN_KEEP_SOL = 0.0006;
const EXEC_MIN_SOL = Math.max(
  0.00002,
  Number((import.meta as any).env?.VITE_TRADE_EXEC_MIN_SOL ?? 0.00005),
);
const envIdleMs = Number((import.meta as any).env?.VITE_BOT_IDLE_REFRESH_MS);
const IDLE_BAL_REFRESH_MS = Math.max(
  10_000,
  Number.isFinite(envIdleMs) ? envIdleMs : 45_000,
);

let TARGET_ALLOC = 0.7;
let MAX_ALLOC = 0.85;
let MIN_ALLOC = 0.6;

const MAX_TOTAL_DRAWDOWN = 0.3;
const MAX_SINGLE_TRADE_IMPACT = 0.015;
const MAX_ROUNDTRIP_LOSS = 0.008;
const DEFAULT_ROUNDTRIP_LOSS = Math.max(
  0.006,
  Math.min(
    MAX_ROUNDTRIP_LOSS,
    Number((import.meta as any).env?.VITE_TRADE_MAX_RT_LOSS ?? 0.007),
  ),
);

const MIN_SLP_BPS = 30;
const MAX_SLP_BPS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function roundTok(tokens: number, decimals: number) {
  const p = Math.pow(10, Math.min(6, decimals));
  return Math.max(0, Math.floor(tokens * p) / p);
}

function capsForStrategy(s: InternalStrategy) {
  switch (s) {
    case "trend":
      return {
        buySlice: 0.0015,
        sellPct: 0.1,
        stepMulMin: 1.0,
        stepMulMax: 1.0,
      };
    case "revert":
      return {
        buySlice: 0.0012,
        sellPct: 0.14,
        stepMulMin: 0.8,
        stepMulMax: 0.9,
      };
    case "scalper":
      return {
        buySlice: 0.0009,
        sellPct: 0.08,
        stepMulMin: 0.5,
        stepMulMax: 0.6,
      };
    case "momentum":
      return {
        buySlice: 0.0018,
        sellPct: 0.12,
        stepMulMin: 1.1,
        stepMulMax: 1.3,
      };
    case "range":
      return {
        buySlice: 0.001,
        sellPct: 0.1,
        stepMulMin: 0.7,
        stepMulMax: 0.9,
      };
    case "maker":
      return {
        buySlice: 0.0006,
        sellPct: 0.06,
        stepMulMin: 0.4,
        stepMulMax: 0.5,
      };
    default:
      return {
        buySlice: 0.0012,
        sellPct: 0.1,
        stepMulMin: 1.0,
        stepMulMax: 1.0,
      };
  }
}

/* ───────────────────────────── Runner ───────────────────────────── */
export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;
  let cooldownUntil = 0;

  // пер‑ботовый backoff при сетевых проблемах
  let failStreak = 0;
  let nextRetryAt = 0;
  let lastWarnTs = 0;

  // защита портфеля
  let baselineValue = 0;

  // поведение
  let buysInRow = 0;
  let sellsInRow = 0;
  let lastBuyTs = 0;
  let lastSellTs = 0;
  let trailHighPrice = 0;

    type DeferredSellMeta = {
      kind?: "micro" | "fee" | "rebalance" | "alloc" | "safety";
      retries?: number;
      maxRetries?: number;
      trailDrop?: number;
      scheduledAt: number;
    };
    let deferredSell: {
      dueAt: number;
      amountTok: number;
      meta?: DeferredSellMeta;
    } | null = null;
    const microIntervalMs = () => 20_000 + Math.floor(Math.random() * 40_000);
    let nextMicroPlanAt = Date.now() + microIntervalMs();
    const rollTpStage1 = () => 0.05 + Math.random() * 0.05;
    const rollTpStage2 = () => 0.15 + Math.random() * 0.02;
    const rollTpPct = (min: number, max: number) =>
      min + Math.random() * Math.max(0, max - min);
    let tpStage1Done = false;
    let tpStage2Done = false;
    let tpStage1Threshold = rollTpStage1();
    let tpStage2Threshold = rollTpStage2();
    let tpStage1Pct = rollTpPct(0.08, 0.12);
    let tpStage2Pct = rollTpPct(0.1, 0.18);
    const resetTpStages = () => {
      tpStage1Done = false;
      tpStage2Done = false;
      tpStage1Threshold = rollTpStage1();
      tpStage2Threshold = rollTpStage2();
      tpStage1Pct = rollTpPct(0.08, 0.12);
      tpStage2Pct = rollTpPct(0.1, 0.18);
    };
  let lastIdleBalanceRefreshAt = Date.now();
    const priceHist: number[] = [];
  const stats = {
    since: Date.now(),
    buyOK: 0,
    sellOK: 0,
    slices: 0,
    skip: {
      minute: 0,
      impact: 0,
      corridorB: 0,
      corridorS: 0,
      illiq: 0,
      cooldown: 0,
      noSol: 0,
      roundtrip: 0,
      exec: 0,
      other: 0,
    },
    quotesFail: 0,
  };
    let lastStatsLogAt = Date.now();
    let lastExecMeta: {
      side: "buy" | "sell" | null;
      pf: number;
      slp: number;
      size: number;
    } = { side: null, pf: PF_BASE_SOL, slp: MIN_SLP_BPS, size: 0 };
    let lastSkipDetail = "n/a";
    let lastGoodPrice = 0;
    const quoteFailures: number[] = [];
    let fallbackQuoteUntil = 0;
    let fallbackNotifiedUntil = 0;

  type SkipReasonKey = keyof typeof stats.skip;
  const zeroSkipCounters = () => ({
    minute: 0,
    impact: 0,
    corridorB: 0,
    corridorS: 0,
    illiq: 0,
    cooldown: 0,
    noSol: 0,
    roundtrip: 0,
    exec: 0,
    other: 0,
  });

    const resetStats = () => {
      stats.since = Date.now();
    stats.buyOK = 0;
    stats.sellOK = 0;
      stats.slices = 0;
      stats.skip = zeroSkipCounters();
      stats.quotesFail = 0;
    };

    const noteSkip = (reason: SkipReasonKey, msg: string) => {
      stats.skip[reason] = (stats.skip[reason] || 0) + 1;
      lastSkipDetail = msg;
      log("info", msg);
    };

    const bumpPriority = (pf: number) =>
      Math.min(PF_MAX_SOL, +(pf + PF_BASE_SOL * 0.75).toFixed(6));

    const reportStats = (trigger: "idle" | "interval") => {
      const now = Date.now();
      const due =
        trigger === "idle"
          ? true
          : now - lastStatsLogAt >= 55_000;
      if (!due) return;
      lastStatsLogAt = now;
      const skip = stats.skip;
        log(
          "info",
          `stats: buyOK=${stats.buyOK} sellOK=${stats.sellOK} impact=${skip.impact} roundtrip=${skip.roundtrip} minute=${skip.minute} corridorB=${skip.corridorB} corridorS=${skip.corridorS} illiq=${skip.illiq} exec=${skip.exec} cooldown=${skip.cooldown} noSol=${skip.noSol}`,
        );
      resetStats();
    };

    const recordQuoteFailure = () => {
      const now = Date.now();
      quoteFailures.push(now);
      while (quoteFailures.length && now - quoteFailures[0] > 20_000) {
        quoteFailures.shift();
      }
      stats.quotesFail++;
      if (quoteFailures.length > 2) {
        fallbackQuoteUntil = now + 15_000;
        if (fallbackNotifiedUntil < now) {
          log(
            "warn",
            "quote fallback: widening slippage + priority fee for next attempt",
          );
          fallbackNotifiedUntil = now + 10_000;
        }
      }
    };

    const clearQuoteFailures = () => {
      quoteFailures.length = 0;
    };

    const priceNowSafe = () => {
      let v = 0;
      try {
        v = Number(ctx.price?.() ?? 0);
      } catch {
        v = 0;
      }
      if (Number.isFinite(v) && v > 0) {
        lastGoodPrice = v;
        return v;
      }
      return Math.max(1e-12, lastGoodPrice || v || 0);
    };
    resetStats();

    const log = (lvl: "info" | "ok" | "warn" | "err", s: string) =>
      ctx.onLog(lvl, `[${bot.name}] ${s}`);
    const reportStop = () => {
      if (ctx.shouldLogStop?.() !== false) {
        log("info", "runner: stopped");
      }
    };
  const warn = (s: string) => {
    const n = Date.now();
    if (n - lastWarnTs > 1500) {
      lastWarnTs = n;
      log("warn", s);
    }
  };

  function pushUpdate(p: Partial<LiveBot>) {
    ctx.onUpdate({ id: bot.id, ...p } as any);
  }

  const alloc = (priceNow: number) => {
    const tokVal = bot.posToken * priceNow;
    const total = Math.max(1e-9, tokVal + bot.solBalance);
    return { tokVal, total, a: tokVal / total };
  };

  // минутные лимиты (по срезам)
  let minWindowStart = Date.now();
  let buysThisMin = 0;
  let sellsThisMin = 0;
  let notionalThisMin = 0;

  // “плохая покупка” — охлаждение
  let lastBuyAtPrice: number | null = null;
  let lastBuyAtTs = 0;
  let lossCooldownUntil = 0;

    function scheduleSell(
      amountTok: number,
      minMs: number,
      maxMs: number,
      meta?: Partial<DeferredSellMeta>,
    ) {
      const now = Date.now();
      const qty = roundTok(Math.max(0, amountTok), ctx.tokenDecimals());
      if (qty <= 0) return false;
      const delay = Math.max(
        0,
        minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)),
      );
      deferredSell = {
        dueAt: now + delay,
        amountTok: qty,
        meta: {
          scheduledAt: now,
          maxRetries:
            meta?.maxRetries ??
            (meta?.kind === "micro" ? 1 : meta?.maxRetries ?? 0),
          retries: meta?.retries ?? 0,
          trailDrop: meta?.trailDrop,
          kind: meta?.kind,
        },
      };
      return true;
    }

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
    opts?: { sellTokens?: number },
  ): Promise<boolean> {
    const execMin = EXEC_MIN_SOL;
    // риски из стора
    let risk = {
      maxImpact: 0.01,
      maxDrawdown: 0.12,
      reserveSol: 0.006,
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
    noLossFloorBps: 18, // базовый "breakeven" коридор (≈0.18%)
    maxRoundtripLoss: DEFAULT_ROUNDTRIP_LOSS,
    } as any;
    try {
      const r = ctx.getRisk?.();
      if (r) risk = { ...risk, ...r };
    } catch {}

    // подхватываем аллокации и форму шага
    try {
      const allocUI = (ctx as any).getAlloc?.();
      if (allocUI && typeof allocUI.target === "number") {
        TARGET_ALLOC = Math.min(0.95, Math.max(0.05, allocUI.target));
        MIN_ALLOC = Math.min(TARGET_ALLOC, Math.max(0.05, allocUI.min ?? 0.6));
        MAX_ALLOC = Math.max(TARGET_ALLOC, Math.min(0.98, allocUI.max ?? 0.85));
      }
    } catch {}

    let step = {
      minSol: 0.0002,
      maxSol: 0.0008,
      slicesMax: 4,
      jitterPct: 0.25,
    };
    try {
      const s = (ctx as any).getTradeStep?.();
      if (s) step = s;
    } catch {}
    const pickStep = () => {
      const base =
        step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
      const jitter =
        1 +
        (Math.random() * 2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
      return Math.max(EXEC_MIN_SOL, +(base * jitter).toFixed(6));
    };

    const kp = ctx.keypair();
    const decimals = ctx.tokenDecimals();
      const priceNow = priceNowSafe();
      const noLossMul =
        1 + Math.max(0, Number(risk.noLossFloorBps) || 0) / 10_000;
      const fallbackActive = Date.now() < fallbackQuoteUntil;
      const rtSampleRate = Math.min(
        1,
        Math.max(0, Number((import.meta as any).env?.VITE_RT_SAMPLE ?? 0.33)),
      );
      const maxImpactAllowed = Math.max(
        0,
        Math.min(0.2, Number(risk.maxImpact ?? MAX_SINGLE_TRADE_IMPACT)),
      );
      const maxRoundtripAllowed = Math.max(
        0,
        Math.min(
          MAX_ROUNDTRIP_LOSS,
          Number(risk.maxRoundtripLoss ?? DEFAULT_ROUNDTRIP_LOSS),
        ),
      );
      const guardFactors = [1, 0.7, 0.55];
      const powDec = Math.pow(10, decimals);
      const quoteFn = (ctx as any).getJupiterQuote || getJupiterQuote;

      const applyBuyGuards = async (
        targetSol: number,
      ): Promise<
        | {
            approvedSize: number;
            outTokens: number;
          }
        | null
      > => {
        for (const factor of guardFactors) {
          const paySol = +Math.max(execMin, targetSol * factor).toFixed(6);
          if (paySol < execMin) continue;
          const lamports = Math.round(paySol * 1e9);
          if (!Number.isFinite(lamports) || lamports <= 0) continue;
          try {
            const q = await quoteFn({
              inputMint: WSOL,
              outputMint: ctx.mint,
              amount: lamports,
            });
            const out = Number(q?.outAmount || 0) / powDec;
            if (!Number.isFinite(out) || out <= 0) {
              recordQuoteFailure();
              continue;
            }
            const fairOut = paySol / Math.max(1e-12, priceNow);
            const impact =
              fairOut > 0 ? Math.max(0, 1 - out / fairOut) : Number.POSITIVE_INFINITY;
            if (impact > maxImpactAllowed) {
              if (factor === guardFactors[guardFactors.length - 1]) {
                noteSkip(
                  "impact",
                  `skip BUY: impact ${(impact * 100).toFixed(1)}% > ${(maxImpactAllowed * 100).toFixed(1)}%`,
                );
              }
              continue;
            }
            if (!fallbackActive && Math.random() < rtSampleRate) {
              try {
                const backRaw = Math.max(1, Math.round(out * powDec));
                const qb = await quoteFn({
                  inputMint: ctx.mint,
                  outputMint: WSOL,
                  amount: backRaw,
                });
                const backSol = Number(qb?.outAmount || 0) / 1e9;
                const lossPct = Math.max(
                  0,
                  1 - backSol / Math.max(1e-12, paySol),
                );
                if (lossPct > maxRoundtripAllowed) {
                  noteSkip(
                    "roundtrip",
                    `skip BUY: roundtrip ${(lossPct * 100).toFixed(2)}% > ${(maxRoundtripAllowed * 100).toFixed(2)}%`,
                  );
                  continue;
                }
              } catch (err) {
                recordQuoteFailure();
                continue;
              }
            }
            return { approvedSize: paySol, outTokens: out };
          } catch {
            recordQuoteFailure();
          }
        }
        return null;
      };

      const applySellGuards = async (
        targetTok: number,
      ): Promise<
        | {
            approvedTokens: number;
            outSol: number;
          }
        | null
      > => {
        for (const factor of guardFactors) {
          const qty = roundTok(Math.max(0, targetTok * factor), decimals);
          if (qty <= 0) continue;
          const raw = Math.max(1, Math.round(qty * powDec));
          try {
            const q = await quoteFn({
              inputMint: ctx.mint,
              outputMint: WSOL,
              amount: raw,
            });
            const outSol = Number(q?.outAmount || 0) / 1e9;
            if (!Number.isFinite(outSol) || outSol <= 0) {
              recordQuoteFailure();
              continue;
            }
            const fair = qty * priceNow;
            const impact =
              fair > 0 ? Math.max(0, 1 - outSol / Math.max(1e-12, fair)) : 0;
            if (impact > maxImpactAllowed) {
              if (factor === guardFactors[guardFactors.length - 1]) {
                noteSkip(
                  "impact",
                  `skip SELL: impact ${(impact * 100).toFixed(1)}% > ${(maxImpactAllowed * 100).toFixed(1)}%`,
                );
              }
              continue;
            }
            if (!fallbackActive && Math.random() < rtSampleRate) {
              try {
                const lamports = Math.max(1, Math.round(outSol * 1e9));
                const qb = await quoteFn({
                  inputMint: WSOL,
                  outputMint: ctx.mint,
                  amount: lamports,
                });
                const backTok = Number(qb?.outAmount || 0) / powDec;
                const lossPct = Math.max(
                  0,
                  1 - backTok / Math.max(1e-12, qty),
                );
                if (lossPct > maxRoundtripAllowed) {
                  noteSkip(
                    "roundtrip",
                    `skip SELL: roundtrip ${(lossPct * 100).toFixed(2)}% > ${(maxRoundtripAllowed * 100).toFixed(2)}%`,
                  );
                  continue;
                }
              } catch {
                recordQuoteFailure();
                continue;
              }
            }
            return { approvedTokens: qty, outSol };
          } catch {
            recordQuoteFailure();
          }
        }
        return null;
      };

    let amountTok: number | undefined =
      side === "sell" && opts?.sellTokens
        ? roundTok(opts.sellTokens, decimals)
        : undefined;
    let minuteRetry = false;
    const isPriming =
      side === "buy" && (bot.posToken <= 0 || (bot.fills ?? 0) === 0);

    // жёсткий коридор до сборки сделки
    try {
        const { a, total } = alloc(priceNow);
        const EPS = 0.002;

          if (side === "buy" && a >= MAX_ALLOC - EPS && !isPriming) {
            noteSkip("corridorB", "skip BUY: max allocation corridor");
            return false;
          }

        if (side === "sell" && a <= MIN_ALLOC + EPS) {
          // обычные продажи ниже коридора запрещаем (кроме принудительных sellTokens для комиссий)
            if (!opts?.sellTokens) {
              noteSkip("corridorS", "skip SELL: min allocation corridor");
            return false;
          }
        }

      if (side === "buy" && sizeSol > 0) {
        const currTokVal = bot.posToken * priceNow;
        const maxBuyVal = Math.max(
          0,
          Math.max(0, MAX_ALLOC - EPS) * total - currTokVal,
        );
        const original = sizeSol;
        const clamped = Math.min(sizeSol, maxBuyVal);
            if (!isPriming && clamped < execMin) {
              noteSkip("corridorB", "skip BUY: clamped size below exec min");
              return false;
            }
          sizeSol = +Math.max(execMin, clamped).toFixed(6);
        if (sizeSol < original - 1e-9)
          log(
            "info",
            `clamped buy ${original.toFixed(6)}→${sizeSol.toFixed(6)}`,
          );
      } else if (side === "sell") {
        const currTokVal = bot.posToken * priceNow;
        const minTokValAfter = Math.max(
          0,
          Math.min(0.98, MIN_ALLOC + EPS) * total,
        );
        const maxSellTok = Math.max(
          0,
          (currTokVal - minTokValAfter) / Math.max(1e-12, priceNow),
        );

        const applyClamp = (src: number) => {
          const cl = Math.min(src, maxSellTok);
          return cl > 0 ? roundTok(cl, decimals) : 0;
        };

        if (opts?.sellTokens) {
          const originalTok = opts.sellTokens;
          const newAmt = applyClamp(originalTok);
              if (newAmt <= 0) {
                noteSkip("corridorS", "skip SELL: clamp exhausted allocation");
              return false;
            }
          (opts as any).sellTokens = newAmt;
          amountTok = newAmt;
          if (newAmt < originalTok - 1e-12)
            log(
              "info",
              `clamped sell ${roundTok(originalTok, decimals)}→${roundTok(newAmt, decimals)}`,
            );
        } else {
          const base = amountTok ?? bot.posToken;
          const capped = applyClamp(base);
              if (capped <= 0) {
                noteSkip("corridorS", "skip SELL: clamp exhausted allocation");
              return false;
            }
          amountTok = capped;
        }
      }
    } catch {}

      if (side === "buy" && sizeSol < execMin) {
      noteSkip("exec", "skip BUY: below exec minimum");
        return false;
      }
      if (side === "sell" && (amountTok ?? bot.posToken) <= 0) {
      noteSkip("exec", "skip SELL: no size after clamp");
        return false;
      }

      if (side === "buy") {
        const guard = await applyBuyGuards(sizeSol > 0 ? sizeSol : pickStep());
        if (!guard) {
          noteSkip("illiq", "skip BUY: unable to obtain safe quote");
          return false;
        }
        sizeSol = guard.approvedSize;
      } else {
        const guard = await applySellGuards(amountTok ?? bot.posToken);
        if (!guard) {
          noteSkip("illiq", "skip SELL: unable to obtain safe quote");
          return false;
        }
        amountTok = guard.approvedTokens;
        if (opts?.sellTokens != null) {
          (opts as any).sellTokens = amountTok;
        }
      }

    // резерв SOL перед покупкой
    if (side === "buy") {
      const reserve = Math.max(MIN_KEEP_SOL, Number(risk.reserveSol) || 0);
      const stepCfg = (ctx as any).getTradeStep?.() ?? { minSol: 0.0002 };
      const need =
        reserve + Math.max(execMin, Number(stepCfg.minSol) || 0.0002);
        if ((bot.solBalance ?? 0) < need) {
          noteSkip("noSol", "skip BUY: low SOL; scheduling tiny SELL for fees");
        if (bot.posToken > 0) {
          const wantSol = Math.min(0.0015, need - (bot.solBalance ?? 0));
          const sellTok = roundTok(
            Math.max(
              0,
              Math.min(
                bot.posToken * (Number(risk.maxSellSliceTokPct) || 0.035),
                wantSol / Math.max(1e-12, priceNow),
              ),
            ),
            decimals,
          );
          if (sellTok > 0) {
            const gmin = Math.max(120, Number(risk.minSliceGapMs) || 600);
            const gmax = Math.max(
              gmin + 50,
              Number(risk.maxSliceGapMs) || 1800,
            );
            scheduleSell(sellTok, gmin, gmax);
          }
        }
        return false;
      }
    }

    // минутные лимиты (окно)
    const nowTs = Date.now();
    if (nowTs - minWindowStart >= 60_000) {
      minWindowStart = nowTs;
      buysThisMin = 0;
      sellsThisMin = 0;
      notionalThisMin = 0;
    }
    if (side === "buy") {
        if (nowTs < lossCooldownUntil && !isPriming) {
          noteSkip("cooldown", "skip BUY: loss cooldown");
        return false;
      }
        if (buysThisMin >= risk.maxBuysPerMin && !isPriming) {
          noteSkip("minute", "skip BUY: per-minute buy count");
        return false;
      }
      const maxNotional = Number(risk.maxNotionalPerMin) || 0;
        if (maxNotional > 0 && !isPriming) {
        while (notionalThisMin + sizeSol > maxNotional) {
          if (minuteRetry) {
            noteSkip(
                "minute",
              `skip BUY: minute notional ${(notionalThisMin + sizeSol).toFixed(
                6,
              )} > ${maxNotional}`,
            );
            return false;
          }
          minuteRetry = true;
          sizeSol = +(sizeSol * 0.6).toFixed(6);
          if (sizeSol < execMin) {
              noteSkip("exec", "skip BUY: retry size fell below exec min");
            return false;
          }
        }
      }
    } else {
        if (sellsThisMin >= risk.maxSellsPerMin) {
          noteSkip("minute", "skip SELL: per-minute sell count");
        return false;
      }
    }

    // адаптивный слиппедж и приоритет
    const short = Math.abs(ctx.changeFast?.(12) || 0);
    const one = Math.abs((ctx.change1m?.() as any) || 0);
    const volScore = Math.max(short, one);
    let lo = MIN_SLP_BPS,
      hi = MAX_SLP_BPS;
    if (volScore < 0.002) {
      lo = 30;
      hi = 60;
    } else if (volScore < 0.006) {
      lo = 50;
      hi = 90;
    } else {
      lo = 80;
      hi = 120;
    }
    const rawBps = Number((ctx as any).slippageBps?.() ?? 50);
    let usedBps = Math.round(Math.max(lo, Math.min(hi, rawBps)));
    if (fallbackActive) {
      usedBps = Math.min(MAX_SLP_BPS, usedBps + 25);
    }
    const multByFail = failStreak >= 4 ? 4 : failStreak >= 2 ? 2 : 1;
    let priorityFeeSol =
      PF_BASE_SOL *
      multByFail *
      (volScore > 0.006 ? 1.35 : volScore > 0.003 ? 1.15 : 1.0);
    if (fallbackActive) {
      priorityFeeSol = bumpPriority(priorityFeeSol);
    }
    priorityFeeSol = Math.min(PF_MAX_SOL, +priorityFeeSol.toFixed(6));
    lastExecMeta = {
      side,
      pf: priorityFeeSol,
      slp: usedBps,
      size:
        side === "buy"
          ? sizeSol
          : opts?.sellTokens ?? bot.posToken ?? 0,
    };

    // payload-шаблон
    const payloadBase = {
      publicKey: kp.publicKey.toBase58(),
      mint: ctx.mint,
      slippage: usedBps / 100,
      priorityFee: priorityFeeSol,
      pool: "auto",
    };

    // разбиение на срезы
    const caps = capsForStrategy(bot.strategy as InternalStrategy);
      let remainingSol = side === "buy" ? sizeSol : 0;
      let remainingTok = side === "sell" ? (amountTok ?? bot.posToken) : 0;
    let maxBuyPerSlice = Math.max(
      execMin,
      Math.min(risk.maxBuySliceSol || 0.0018, caps.buySlice),
    );
    const maxSellPct = Math.min(
      0.5,
      Math.max(0.02, Math.min(risk.maxSellSliceTokPct || 0.12, caps.sellPct)),
    );
    const maxSellPerSlice =
      side === "sell"
        ? roundTok((bot.posToken || 0) * maxSellPct, decimals)
        : 0;

    let slices = Math.max(
      1,
      Math.min(
        step.slicesMax,
        Math.round(1 + Math.random() * (step.slicesMax - 1)),
      ),
    );
    if (side === "sell" && maxSellPerSlice > 0) {
      const need = Math.ceil(remainingTok / Math.max(1e-12, maxSellPerSlice));
      slices = Math.min(step.slicesMax, Math.max(slices, need));
    }

    // локальное состояние для mid‑slice пересчёта коридора и no‑loss фильтра
    let localPosToken = bot.posToken;
    let localSol = bot.solBalance;

    // аккумулируем фактически исполненный объём (для корректных avg/realized)
    let executedSol = 0;
    let executedTok = 0;
    let executedSlices = 0;

    // EPS для коридора
    const EPS = 0.0015;

    for (let si = 0; si < slices; si++) {
      // формируем amount для текущего среза + re-eval коридора
      let pl: any;
      if (side === "buy") {
        const pnow = priceNowSafe();
        const currTokVal = localPosToken * pnow;
        const totalLocal = Math.max(1e-9, currTokVal + localSol);
        const maxBuyValLoc = Math.max(
          0,
          Math.max(0, MAX_ALLOC - EPS) * totalLocal - currTokVal,
        );
        if (maxBuyValLoc <= 0) {
          if (executedSlices > 0)
            log(
              "info",
              `stop BUY slicing: would breach maxAlloc ${(MAX_ALLOC * 100).toFixed(1)}%`,
            );
          break;
        }

        let pay = Math.min(maxBuyPerSlice, remainingSol, maxBuyValLoc);
        if (pay < execMin) break;
        pl = {
          ...payloadBase,
          action: "buy",
          denominatedInSol: "true",
          amount: +pay.toFixed(6),
        };
        remainingSol = Math.max(0, +(remainingSol - pay).toFixed(6));

        // при высокой волатильности ужимаем размер следующего среза
        const volScoreNow = Math.max(
          Math.abs(ctx.changeFast?.(8) || 0),
          Math.abs(ctx.change1m?.() || 0),
        );
        if (volScoreNow > 0.006)
          maxBuyPerSlice = Math.max(
            execMin,
            +(maxBuyPerSlice * 0.75).toFixed(6),
          );

        // минутные лимиты по срезу
        const now2 = Date.now();
        if (now2 - minWindowStart >= 60_000) {
          minWindowStart = now2;
          buysThisMin = 0;
          sellsThisMin = 0;
          notionalThisMin = 0;
        }
          if (buysThisMin >= risk.maxBuysPerMin) {
            noteSkip("minute", "skip BUY slice: per-minute buy count");
            break;
          }
          if (
            notionalThisMin + pl.amount >
            (Number(risk.maxNotionalPerMin) || 0)
          ) {
            if (!minuteRetry) {
              const reduced = +(pl.amount * 0.6).toFixed(6);
              minuteRetry = true;
              if (reduced >= execMin) {
                remainingSol = Math.max(
                  0,
                  +(remainingSol + (pl.amount - reduced)).toFixed(6),
                );
                pl.amount = reduced;
              } else {
                  noteSkip(
                    "exec",
                    "skip BUY slice: retry amount fell below exec min",
                  );
                break;
              }
            }
            if (
              notionalThisMin + pl.amount >
              (Number(risk.maxNotionalPerMin) || 0)
            ) {
                noteSkip("minute", "skip BUY slice: minute notional");
              break;
            }
          }
      } else {
        const pnow = priceNowSafe();
        const currTokVal = localPosToken * pnow;
        const totalLocal = Math.max(1e-9, currTokVal + localSol);
        const minTokValAf = Math.max(
          0,
          Math.min(0.98, MIN_ALLOC + EPS) * totalLocal,
        );
        const maxSellTokLoc = Math.max(
          0,
          (currTokVal - minTokValAf) / Math.max(1e-12, pnow),
        );
        if (maxSellTokLoc <= 0) {
          if (executedSlices > 0)
            log(
              "info",
              `stop SELL slicing: would breach minAlloc ${(MIN_ALLOC * 100).toFixed(1)}%`,
            );
          break;
        }

        let qty = (() => {
          const cap =
            maxSellPerSlice > 0
              ? Math.min(maxSellPerSlice, remainingTok, maxSellTokLoc)
              : Math.min(
                  remainingTok / Math.max(1, slices - si),
                  maxSellTokLoc,
                );
          return roundTok(Math.max(0, cap), decimals);
        })();

        if (qty <= 0) break;

        // no‑loss фильтр: обычные продажи ниже avg запрещаем (кроме маленьких служебных)
        if (
          !opts?.sellTokens &&
          bot.avgSol > 0 &&
          risk.noLossFloorBps &&
          risk.noLossFloorBps > 0
        ) {
          if (pnow < bot.avgSol * noLossMul) {
            // переносим часть в отложенную — дадим рынку отскочить
            const gmin = Math.max(120, Number(risk.minSliceGapMs) || 600);
            const gmax = Math.max(
              gmin + 50,
              Number(risk.maxSliceGapMs) || 1800,
            );
            scheduleSell(qty, gmin, gmax);
              noteSkip(
                "cooldown",
                `skip SELL no-loss floor (${((noLossMul - 1) * 100).toFixed(2)}%), deferred`,
              );
            break;
          }
        }

        // проверка импакта по текущему срезу с попыткой ужать qty
          try {
            const rawQ = Math.max(1, Math.round(qty * Math.pow(10, decimals)));
            const q = await quoteFn({
              inputMint: ctx.mint,
              outputMint: WSOL,
              amount: rawQ,
            });
            const outSol = Number(q?.outAmount || 0) / 1e9;
            if (!isFinite(outSol) || outSol <= 0) {
              recordQuoteFailure();
              noteSkip("illiq", "skip SELL: illiquid route");
              break;
            }
            const fair = qty * pnow;
            const thr = Math.max(
              0,
              Math.min(0.2, Number(risk.maxImpact ?? MAX_SINGLE_TRADE_IMPACT)),
            );
            let impact = fair > 0 ? Math.max(0, 1 - outSol / fair) : 0;

              if (impact > thr) {
                let adjusted = false;
                for (const factor of [0.7, 0.55]) {
                  const shrunk = roundTok(qty * factor, decimals);
                  if (shrunk <= 0 || shrunk >= qty) continue;
                  const rawShrink = Math.max(1, Math.round(shrunk * powDec));
                  const qShrink = await quoteFn({
                    inputMint: ctx.mint,
                    outputMint: WSOL,
                    amount: rawShrink,
                  });
                  const outShrink = Number(qShrink?.outAmount || 0) / 1e9;
                  const impShrink =
                    shrunk * pnow > 0
                      ? Math.max(0, 1 - outShrink / (shrunk * pnow))
                      : 0;
                  if (impShrink <= thr) {
                    qty = shrunk;
                    adjusted = true;
                    break;
                  }
                }
                if (!adjusted) {
                    noteSkip(
                      "impact",
                      `skip SELL: impact ${(impact * 100).toFixed(1)}% > ${(thr * 100).toFixed(1)}%`,
                    );
                  break;
                }
              }
          } catch {
            recordQuoteFailure();
              noteSkip("illiq", "skip SELL: quote fetch failed");
            break;
          }

        const now2 = Date.now();
        if (now2 - minWindowStart >= 60_000) {
          minWindowStart = now2;
          buysThisMin = 0;
          sellsThisMin = 0;
          notionalThisMin = 0;
        }
            if (sellsThisMin >= (Number(risk.maxSellsPerMin) || 0)) {
              noteSkip("minute", "skip SELL slice: per-minute sell count");
            break;
          }

        pl = {
          ...payloadBase,
          action: "sell",
          denominatedInSol: "false",
          amount: qty,
        };
        remainingTok = Math.max(0, remainingTok - qty);
      }

      // отправка
        const sliceSizeMsg =
          pl.action === "buy"
            ? `${Number(pl.amount || 0).toFixed(6)} SOL`
            : `${roundTok(Number(pl.amount || 0), decimals)} TOK`;
        log(
          "info",
          `slice ${pl.action.toUpperCase()} ${sliceSizeMsg} slp=${usedBps} pf=${Number(
            pl.priorityFee ?? priorityFeeSol,
          ).toFixed(6)}`,
        );
        const vtx = await buildTradeTxPump(pl);
      vtx.sign([kp]);
      const sig = await connection.sendRawTransaction(vtx.serialize(), {
        skipPreflight: true,
        maxRetries: 4,
      });
      await confirmSigHttp(connection, sig);

      executedSlices++;
      if (pl.action === "buy") {
        executedSol += pl.amount;
          localPosToken += pl.amount / Math.max(1e-12, priceNowSafe());
        localSol = Math.max(0, localSol - pl.amount - FEE_EST_SOL);
        buysThisMin++;
        notionalThisMin = +(notionalThisMin + pl.amount).toFixed(6);
      } else {
        executedTok += pl.amount;
        localPosToken = Math.max(0, localPosToken - pl.amount);
          localSol += Math.max(
            0,
            pl.amount * Math.max(1e-12, priceNowSafe()) - FEE_EST_SOL,
          );
        sellsThisMin++;
      }

      if (
        si < slices - 1 &&
        (pl.action === "buy" ? remainingSol > 0 : remainingTok > 0)
      ) {
        const gmin = Math.max(120, risk.minSliceGapMs || 600);
        const gmax = Math.max(gmin + 50, risk.maxSliceGapMs || 1800);
        const gap = gmin + Math.floor(Math.random() * (gmax - gmin));
        await sleep(gap);
      }
    }

      if (executedSlices === 0) {
        if (failStreak >= 3) {
          const nextPf = bumpPriority(priorityFeeSol);
          const nextSlp = Math.min(MAX_SLP_BPS, usedBps + 15);
          log(
            "info",
            `no execution (reason: ${lastSkipDetail}) → next pf=${nextPf.toFixed(6)} slp=${nextSlp}`,
          );
        }
        return false;
      }

    // успех — сбрасываем backoff
    failStreak = 0;
    nextRetryAt = 0;

    // локальная фиксация состояний (только по исполненному!)
    const pnow = priceNowSafe();
    if (side === "buy") {
      const qty = executedSol / pnow;
      const newPos = bot.posToken + qty;
      bot.avgSol =
        newPos > 0 ? (bot.avgSol * bot.posToken + executedSol) / newPos : pnow;
      bot.posToken = newPos;
      bot.solBalance = Math.max(
        0,
        (bot.solBalance ?? 0) - executedSol - FEE_EST_SOL * executedSlices,
      );
      bot.tokenBalance = bot.posToken;

      buysInRow++;
      sellsInRow = 0;
      lastBuyTs = Date.now();
      lastBuyAtPrice = pnow;
      lastBuyAtTs = Date.now();
      if (trailHighPrice <= 0 || pnow > trailHighPrice) trailHighPrice = pnow;
    } else {
      const sellQty =
        executedTok > 0 ? executedTok : (amountTok ?? bot.posToken);
      bot.realized = safeAdd(
        bot.realized || 0,
        safeMultiply((pnow || 0) - (bot.avgSol || pnow || 0), sellQty || 0),
      );
      bot.posToken = Math.max(0, bot.posToken - sellQty);
      bot.avgSol = bot.posToken > 0 ? bot.avgSol : 0;
      bot.solBalance = Math.max(
        0,
        (bot.solBalance ?? 0) +
          Math.max(0, sellQty * pnow - FEE_EST_SOL * executedSlices),
      );
      bot.tokenBalance = bot.posToken;

      sellsInRow++;
      buysInRow = 0;
      lastSellTs = Date.now();
      if (bot.posToken <= 0) trailHighPrice = 0;
    }

      bot.unrealized = safeMultiply(
      bot.posToken || 0,
      (pnow || 0) - (bot.avgSol || pnow || 0),
    );
    bot.fills += executedSlices;
    bot.last =
      side === "buy"
        ? `buy ${executedSol.toFixed(6)} SOL @ slp=${usedBps.toFixed(0)}bps`
        : `sell ${roundTok(executedTok, decimals)} TOK @ slp=${usedBps.toFixed(0)}bps`;

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
      stats.slices += executedSlices;
        if (side === "buy") stats.buyOK++;
        else stats.sellOK++;
      lastExecMeta = {
        side,
        pf: priorityFeeSol,
        slp: usedBps,
        size: side === "buy" ? executedSol : executedTok,
      };
      clearQuoteFailures();
      fallbackQuoteUntil = 0;
      reportStats("interval");
    log("ok", `${side.toUpperCase()} executed (slices ${executedSlices})`);

    // on-chain refresh + мягкий refresh всего стора
    await refreshOnChainBalances();
    lastIdleBalanceRefreshAt = Date.now();
    try {
      ctx.afterTrade?.("trade");
    } catch {}

    // пост‑коррекция к коридору/цели
    try {
      const { tokVal, total, a } = alloc(pnow);
      const reserve = Math.max(MIN_KEEP_SOL, Number(risk.reserveSol) || 0);
      const gmin = Math.max(120, Number(risk.minSliceGapMs) || 200);
      const gmax = Math.max(gmin + 50, Number(risk.maxSliceGapMs) || 850);

      if (a > MAX_ALLOC + 0.002) {
        const targetVal = TARGET_ALLOC * total;
        const gapTok = Math.max(0, (tokVal - targetVal) / pnow);
        const capPct = Math.min(
          0.5,
          Math.max(0.02, Number(risk.maxSellSliceTokPct) || 0.12),
        );
        const maxTok = Math.min(bot.posToken * capPct, gapTok);
        const amt = roundTok(Math.max(0, maxTok), decimals);
        if (amt > 0) scheduleSell(amt, gmin, gmax);
      } else if (a < MIN_ALLOC - 0.002) {
        const targetVal = TARGET_ALLOC * total;
        const needSol = Math.max(0, targetVal - tokVal);
        const headroom = Math.max(
          0,
          (bot.solBalance ?? 0) - (reserve + 0.0001),
        );
        let buySol = Math.max(
          0,
          Math.min(
            needSol,
            headroom,
            Math.max(execMin, Number(risk.maxBuySliceSol) || 0.0018),
          ),
        );
        if (buySol >= EXEC_MIN_SOL) {
          const delay =
            gmin + Math.floor(Math.random() * Math.max(1, gmax - gmin));
          setTimeout(() => {
            void twapBuy(+buySol.toFixed(6)).catch(() => {});
          }, delay);
        } else if (needSol > 0 && headroom <= 0) {
          const wantSol = Math.min(
            needSol * 0.3,
            reserve + 0.001 - (bot.solBalance ?? 0),
          );
          const sellTok = roundTok(
            Math.max(
              0,
              Math.min(
                bot.posToken * (Number(risk.maxSellSliceTokPct) || 0.12),
                wantSol / pnow,
              ),
            ),
            decimals,
          );
          if (sellTok > 0) scheduleSell(sellTok, gmin, gmax);
        }
      }
    } catch {}

    cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
    return true;
  }

  async function twapBuy(totalSol: number): Promise<boolean> {
    const execMin = EXEC_MIN_SOL;
    if (totalSol < execMin) return false;
    const plan = ctx.twap;
    if (!plan || plan.slices < 2) {
      return trade("buy", totalSol);
    }

    const maxSlices = Math.min(
      plan.slices,
      Math.max(1, Math.floor(totalSol / execMin)),
    );
    if (maxSlices <= 1) {
      return trade("buy", totalSol);
    }

    let executed = false;
    let remaining = +totalSol.toFixed(6);

    for (let i = 0; i < maxSlices; i++) {
      const slicesLeft = maxSlices - i;
      let sliceAmount = +(remaining / slicesLeft).toFixed(6);
      if (sliceAmount < execMin) {
        sliceAmount = remaining;
      }
      if (sliceAmount < execMin) break;

      const ok = await trade("buy", sliceAmount);
      if (ok) {
        executed = true;
        remaining = Math.max(0, +(remaining - sliceAmount).toFixed(6));
      } else {
        break;
      }

      if (remaining < execMin) break;
      if (i < maxSlices - 1 && remaining >= execMin) {
        await sleep(Math.max(300, plan.gapMs));
      }
    }

    if (!executed && remaining >= execMin) {
      executed = await trade("buy", remaining);
    }
    return executed;
  }

  // старт основной петли с дезинхронизирующей задержкой
  setTimeout(loop, 100 + Math.floor(Math.random() * 500));
    const stop: any = () => {
      stopped = true;
      reportStop();
    };
  stop.scheduleMicroSell = (
    pctMin: number,
    pctMax: number,
    minDelayMs: number,
    maxDelayMs: number,
  ) => {
    if (stopped) return false;
    const decimals = ctx.tokenDecimals();
    const lo = Math.max(0, Math.min(1, pctMin));
    const hi = Math.max(lo, Math.min(1, pctMax));
    const pct = lo + Math.random() * Math.max(0, hi - lo);
    const qty = roundTok(bot.posToken * pct, decimals);
    if (qty <= 0) return false;
    const minMs = Math.max(200, Math.floor(minDelayMs));
    const maxMs = Math.max(minMs, Math.floor(maxDelayMs));
      const scheduled = scheduleSell(qty, minMs, maxMs, {
        kind: "micro",
        maxRetries: 1,
        trailDrop: 0.007 + Math.random() * 0.005,
      });
      if (scheduled) nextMicroPlanAt = Date.now() + microIntervalMs();
      return scheduled;
  };
  return stop;

  async function loop() {
    if (stopped || !bot.running || ctx.abortSignal?.aborted) return;
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

      let risk: any = {};
      try {
        risk = ctx.getRisk?.() || {};
      } catch {}
      const loopNoLossMul =
        1 + Math.max(0, Number(risk.noLossFloorBps) || 0) / 10_000;

      if (
        bot.posToken > 0 &&
        now >= nextMicroPlanAt &&
        (!deferredSell || deferredSell.meta?.kind !== "micro")
      ) {
        const decimals = ctx.tokenDecimals();
        const pct = 0.03 + Math.random() * 0.05;
        const qty = roundTok(bot.posToken * pct, decimals);
        const drop = 0.007 + Math.random() * 0.005;
        const minDelay = 1200 + Math.floor(Math.random() * 2500);
        const maxDelay = minDelay + 4000 + Math.floor(Math.random() * 3500);
        let scheduled = false;
        if (qty > 0) {
          scheduled = scheduleSell(qty, minDelay, maxDelay, {
            kind: "micro",
            maxRetries: 1,
            trailDrop: drop,
          });
        }
        nextMicroPlanAt =
          Date.now() +
          (scheduled ? microIntervalMs() : 12_000 + Math.floor(Math.random() * 8_000));
      }

    if (lossCooldownUntil && now >= lossCooldownUntil) {
      log("info", "loss cooldown ended");
      lossCooldownUntil = 0;
    }

    // выполнить отложенную маленькую продажу (для комиссий/сглаживания)
      if (deferredSell && now >= deferredSell.dueAt && bot.posToken > 0) {
        pending = true;
        const meta = deferredSell.meta;
        let executedDeferred = false;
        let attemptedQty = 0;
        try {
          const sinceBuy = now - (lastBuyTs || 0);
          if (meta?.kind === "micro" && sinceBuy < 8000) {
            const push = 6_000 + Math.floor(Math.random() * 6_000);
            deferredSell = {
              ...deferredSell,
              dueAt: now + push,
              meta: {
                ...meta,
                retries: (meta.retries ?? 0) + 1,
              },
            };
            pending = false;
            const jitter = 200 + Math.floor(Math.random() * 300);
            return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
          }

          const priceNowLoop = priceNowSafe();
          let qty = roundTok(
            Math.min(deferredSell.amountTok, bot.posToken),
            ctx.tokenDecimals(),
          );

          if (qty <= 0) {
            deferredSell = null;
          } else {
            if (meta?.kind === "micro") {
              const dropThr = meta.trailDrop ?? 0.009;
              const priceOk =
                (bot.avgSol <= 0 || priceNowLoop >= bot.avgSol * loopNoLossMul) ||
                (trailHighPrice > 0 &&
                  priceNowLoop >= trailHighPrice * (1 - dropThr));
              const totalNow =
                bot.solBalance + bot.posToken * priceNowLoop;
              const futureTokVal = Math.max(
                0,
                (bot.posToken - qty) * priceNowLoop,
              );
              const futureAlloc =
                totalNow > 0 ? futureTokVal / Math.max(1e-9, totalNow) : 0;
              const corridorOk = futureAlloc >= MIN_ALLOC - 0.002;
              if (!priceOk || !corridorOk) {
                const canRetry =
                  (meta.retries ?? 0) < (meta.maxRetries ?? 0);
                if (canRetry) {
                  deferredSell = {
                    dueAt:
                      now +
                      10_000 +
                      Math.floor(Math.random() * 10_000),
                    amountTok: deferredSell.amountTok,
                    meta: {
                      ...meta,
                      retries: (meta.retries ?? 0) + 1,
                    },
                  };
                } else {
                  deferredSell = null;
                  nextMicroPlanAt = Date.now() + microIntervalMs();
                }
                pending = false;
                const jitter = 200 + Math.floor(Math.random() * 300);
                return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
              }
            }

            const capPct =
              meta?.kind === "micro"
                ? 0.12
                : meta?.kind === "fee"
                ? 0.25
                : 0.5;
            const capTok = roundTok(
              Math.min(bot.posToken * capPct, deferredSell.amountTok),
              ctx.tokenDecimals(),
            );
            qty = roundTok(Math.min(qty, capTok, bot.posToken), ctx.tokenDecimals());
            if (qty > 0) {
              attemptedQty = qty;
              executedDeferred = await trade("sell", 0, { sellTokens: qty });
            }
          }
        } catch {}
        if (!executedDeferred && attemptedQty > 0 && deferredSell) {
          const metaNow = deferredSell.meta ?? { scheduledAt: Date.now() };
          const canRetry =
            metaNow.kind !== "micro" ||
            (metaNow.retries ?? 0) < (metaNow.maxRetries ?? 0);
          if (canRetry) {
            const deferBase =
              metaNow.kind === "micro"
                ? 6_000 + Math.floor(Math.random() * 8_000)
                : Math.round(bot.speedMs * (0.8 + Math.random() * 0.7));
            deferredSell = {
              dueAt: Date.now() + Math.max(1_200, deferBase),
              amountTok: attemptedQty,
              meta: {
                ...metaNow,
                retries: (metaNow.retries ?? 0) + 1,
              },
            };
          } else {
            if (metaNow.kind === "micro") {
              nextMicroPlanAt = Date.now() + microIntervalMs();
            }
            deferredSell = null;
          }
        } else {
          if (deferredSell?.meta?.kind === "micro") {
            nextMicroPlanAt = Date.now() + microIntervalMs();
          }
          deferredSell = null;
        }
        pending = false;
        const jitter = 200 + Math.floor(Math.random() * 300);
        return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
      }

    pending = true;
    try {
      // легкий рефреш
        if (ctx.shouldLightRefresh?.(10000)) {
          log("info", "light refresh: refreshing balances");
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

    const p = priceNowSafe();
      priceHist.push(p);
      if (priceHist.length > 120) priceHist.shift();
      const fast = ctx.changeFast?.(12) ?? 0;
      const ch1m = ctx.change1m();

      const { a: allocTok, total } = alloc(p);
        if (bot.posToken <= 0 && (tpStage1Done || tpStage2Done)) {
          resetTpStages();
        }
      const portfolioNow = bot.solBalance + bot.posToken * p;
      if (baselineValue === 0) baselineValue = portfolioNow;

      const protect =
        portfolioNow <
        baselineValue *
          (1 - Math.min(MAX_TOTAL_DRAWDOWN, risk.maxDrawdown ?? 0.12));

      // bad‑buy cooldown
      try {
        const thr = Math.max(0, Number(risk.lossThrPct) || 0);
        const win = Math.max(0, Number(risk.lossWindowMs) || 0);
        const cool = Math.max(0, Number(risk.lossCooldownMs) || 0);
        const since = now - (lastBuyAtTs || 0);
        if (lastBuyAtPrice && win > 0 && since <= win) {
          const drop = Math.max(
            0,
            (lastBuyAtPrice - p) / Math.max(1e-12, lastBuyAtPrice),
          );
          if (drop >= thr) {
            const until = now + cool;
            if (until > lossCooldownUntil) {
              lossCooldownUntil = until;
              log(
                "warn",
                `start cooldown: drop ${(drop * 100).toFixed(2)}% ≥ ${(thr * 100).toFixed(2)}%, ${Math.round(cool / 1000)}s`,
              );
            }
            lastBuyAtPrice = null;
          }
        } else if (win > 0 && since > win) lastBuyAtPrice = null;
      } catch {}

      // trailing high обновляем
      if (bot.posToken > 0) trailHighPrice = Math.max(trailHighPrice || p, p);
      else trailHighPrice = 0;

      // профиль шага под стратегию
      let step = {
        minSol: 0.0002,
        maxSol: 0.0008,
        slicesMax: 4,
        jitterPct: 0.25,
      };
      try {
        const s = (ctx as any).getTradeStep?.();
        if (s) step = s;
      } catch {}
      const cap = capsForStrategy(bot.strategy as InternalStrategy);
      step.minSol = +(step.minSol * cap.stepMulMin).toFixed(6);
      step.maxSol = +(step.maxSol * cap.stepMulMax).toFixed(6);
      const volScoreForStep = Math.max(
        Math.abs(ctx.changeFast?.(8) || 0),
        Math.abs(ctx.change1m?.() || 0),
      );
      if (volScoreForStep > 0.006)
        step.maxSol = +(step.maxSol * 0.8).toFixed(6);
      const pickStep = () => {
        const base =
          step.minSol + Math.random() * Math.max(0, step.maxSol - step.minSol);
        const jitter =
          1 +
          (Math.random() * 2 - 1) * Math.min(0.5, Math.max(0, step.jitterPct));
        return Math.max(EXEC_MIN_SOL, +(base * jitter).toFixed(6));
      };

      const reserve = Math.max(MIN_KEEP_SOL, risk.reserveSol || 0.0009);
      const baseSize = Math.max(
        step.minSol,
        Math.min(
          bot.budgetSol || ctx.tradeSize() || step.maxSol,
          bot.solBalance - (reserve + step.minSol),
        ),
      );
      const haveSol = bot.solBalance > reserve + 0.00015;
      const eps = 0.005;

      // экстренная продажа на комиссии, если SOL мало
        if (bot.posToken > 0 && bot.solBalance < reserve) {
          const needSol = Math.max(0, reserve + 0.0015 - bot.solBalance);
          const tokToSell = roundTok(
            Math.min(bot.posToken * 0.25, needSol / Math.max(1e-12, p)),
            ctx.tokenDecimals(),
          );
          const priceOkForFeeSell =
            bot.avgSol <= 0 ||
              (risk.noLossFloorBps ?? 0) <= 0 ||
              p >= bot.avgSol * loopNoLossMul ||
            bot.solBalance < reserve * 0.4;
          if (tokToSell > 0) {
            if (priceOkForFeeSell) {
              const sold = await trade("sell", 0, {
                sellTokens: tokToSell,
              });
              if (sold) {
                pending = false;
                const jitter = 200 + Math.floor(Math.random() * 300);
                return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
              }
            } else {
              const gmin = Math.max(200, Number(risk.minSliceGapMs) || 600);
              const gmax = Math.max(gmin + 200, Number(risk.maxSliceGapMs) || 1800);
              scheduleSell(tokToSell, gmin, gmax, { kind: "fee", maxRetries: 1 });
            }
          }
        }

      // пред‑стратегическая авто‑ребалансировка
        if (bot.posToken > 0 && allocTok > MAX_ALLOC + eps) {
          const desiredTokVal = TARGET_ALLOC * total;
          const currentTokVal = bot.posToken * p;
          const excessVal = Math.max(0, currentTokVal - desiredTokVal);
          const factor = 0.5 + Math.random() * 0.25;
          const targetSellVal = excessVal * factor;
          const tokToSell = Math.min(
            bot.posToken,
            roundTok(
              Math.max(bot.posToken * 0.08, targetSellVal / Math.max(1e-12, p)),
              ctx.tokenDecimals(),
            ),
          );
          if (tokToSell > 0) {
            const sold = await trade("sell", 0, { sellTokens: tokToSell });
            if (sold) {
              pending = false;
              const jitter = 200 + Math.floor(Math.random() * 300);
              return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
            }
          }
        }

      // Bootstrap-buy: если позиция пустая, но есть SOL и аллокация < MIN_ALLOC
      if (bot.posToken <= 0 && haveSol && p > 0 && allocTok < MIN_ALLOC) {
        const targetVal = TARGET_ALLOC * total;
        const needVal = Math.max(0, targetVal);
        const buySol = Math.max(
          EXEC_MIN_SOL,
          Math.min(Math.min(baseSize * 0.5, pickStep()), needVal, reserve * 2),
        );
        if (buySol >= EXEC_MIN_SOL) {
          log("info", `bootstrap-buy: posToken=0, trying ${buySol.toFixed(6)} SOL`);
          const bought = await twapBuy(buySol);
          if (bought) {
            pending = false;
            const jitter = 200 + Math.floor(Math.random() * 300);
            return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
          }
        }
      }

      if (!protect && allocTok < MIN_ALLOC - eps) {
        if (!haveSol) {
          const targetVal = TARGET_ALLOC * total;
          const needVal = Math.max(0, targetVal - bot.posToken * p);
          const tokToSell = roundTok(
            Math.max(
              bot.posToken * 0.08,
              Math.min(bot.posToken * 0.2, (needVal * 0.25) / p),
            ),
            ctx.tokenDecimals(),
          );
          if (tokToSell > 0) {
            const sold = await trade("sell", 0, { sellTokens: tokToSell });
            if (sold) {
              pending = false;
              const jitter = 200 + Math.floor(Math.random() * 300);
              return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
            }
          }
        }
        const targetVal = TARGET_ALLOC * total;
        const needVal = Math.max(0, targetVal - bot.posToken * p);
        const buySol = Math.max(
          0,
          Math.min(Math.min(baseSize, pickStep()), needVal),
        );
        if (buySol >= EXEC_MIN_SOL) {
          const bought = await twapBuy(buySol);
          if (bought) {
            pending = false;
            const jitter = 200 + Math.floor(Math.random() * 300);
            return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
          }
        }
      }

        // стратегии pump → pullback → pump
        let did = false;
        if (bot.posToken > 0 && bot.avgSol > 0) {
          const gain =
            (p - bot.avgSol) / Math.max(1e-9, bot.avgSol || p || 1);
          if (!tpStage1Done && gain >= tpStage1Threshold) {
            const sellTok = roundTok(
              Math.max(0, bot.posToken * tpStage1Pct),
              ctx.tokenDecimals(),
            );
            if (sellTok > 0) {
              const sold = await trade("sell", 0, { sellTokens: sellTok });
              if (sold) {
                tpStage1Done = true;
                did = true;
              }
            }
          }
          if (
            !did &&
            tpStage1Done &&
            !tpStage2Done &&
            gain >= tpStage2Threshold
          ) {
            const sellTok2 = roundTok(
              Math.max(0, bot.posToken * tpStage2Pct),
              ctx.tokenDecimals(),
            );
            if (sellTok2 > 0) {
              const sold2 = await trade("sell", 0, { sellTokens: sellTok2 });
              if (sold2) {
                tpStage2Done = true;
                did = true;
              }
            }
          }
        }
      const strat = bot.strategy as InternalStrategy;

      switch (strat) {
        case "trend": {
          if (
            buysInRow >= 2 &&
            fast > 0.001 &&
            trailHighPrice > 0 &&
            p < trailHighPrice * 0.9995
          ) {
            const pause = bot.speedMs * (1 + Math.random());
            cooldownUntil = Date.now() + Math.max(600, Math.min(2400, pause));
            log("info", `micro-cooldown ${Math.round(pause)}ms`);
            break;
          }
          if (
            !protect &&
            haveSol &&
            fast > 0 &&
            ch1m > 0.001 &&
            allocTok < MAX_ALLOC
          ) {
            const headroomToMax = Math.max(
              0,
              MAX_ALLOC * total - bot.posToken * p,
            );
            const size = Math.min(
              Math.min(baseSize, pickStep()),
              headroomToMax,
            );
            if (size >= EXEC_MIN_SOL) {
              const bought = await twapBuy(size);
              if (bought) {
                did = true;
                break;
              }
            }
          }
          if (bot.posToken > 0 && bot.avgSol > 0) {
            const r = (p - bot.avgSol) / Math.max(1e-9, bot.avgSol);
            if (r >= 0.07) {
              const pct = 0.08 + Math.random() * 0.1;
              const part = roundTok(
                Math.max(0, bot.posToken * pct),
                ctx.tokenDecimals(),
              );
              if (part > 0) {
                const sold = await trade("sell", 0, { sellTokens: part });
                if (sold) {
                  did = true;
                  break;
                }
              }
            }
          }
          if (!did && bot.posToken > 0 && trailHighPrice > 0) {
            const dd = (p - trailHighPrice) / Math.max(1e-9, trailHighPrice);
            if (dd <= -0.009) {
              const pct = 0.06 + Math.random() * 0.06;
              const part = roundTok(
                Math.max(0, bot.posToken * pct),
                ctx.tokenDecimals(),
              );
              if (part > 0) {
                const sold = await trade("sell", 0, { sellTokens: part });
                if (sold) {
                  did = true;
                  break;
                }
              }
            }
          }
          if (!did && (allocTok > MAX_ALLOC || protect)) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(
                Math.max(bot.posToken * 0.1, (excessVal * 0.5) / p),
                ctx.tokenDecimals(),
              ),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) {
                did = true;
              }
            }
          }
          break;
        }
        case "revert": {
          const N = Math.min(90, priceHist.length);
          const M = Math.max(12, Math.min(36, N));
          const slice = priceHist.slice(-M);
          const mean =
            slice.reduce((s, x) => s + x, 0) / Math.max(1, slice.length);
          const sd = Math.sqrt(
            slice.reduce((s, x) => s + (x - mean) * (x - mean), 0) /
              Math.max(1, slice.length),
          );
          const dev = mean > 0 ? (p - mean) / mean : 0;

          if (
            !protect &&
            haveSol &&
            allocTok < MAX_ALLOC - 0.001 &&
            fast < 0 &&
            dev <= -0.007 &&
            Date.now() >= lossCooldownUntil
          ) {
            const headroomToMax = Math.max(
              0,
              MAX_ALLOC * total - bot.posToken * p,
            );
            const size = Math.min(
              Math.min(baseSize, pickStep()),
              headroomToMax,
            );
            if (size >= EXEC_MIN_SOL) {
              const bought = await twapBuy(size);
              if (bought) {
                did = true;
                break;
              }
            }
          }
          const smallProfit =
            bot.avgSol > 0
              ? (p - bot.avgSol) / Math.max(1e-9, bot.avgSol) >= 0.012
              : false;
          const nearMean = Math.abs(dev) <= 0.0015;
          if (!did && bot.posToken > 0 && (smallProfit || nearMean)) {
            const pct = 0.08 + Math.random() * 0.07;
            const part = roundTok(
              Math.max(0, bot.posToken * pct),
              ctx.tokenDecimals(),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) {
                did = true;
              }
            }
          }
          if (!did && bot.posToken > 0 && dev >= 0.008) {
            const pct = 0.08 + Math.random() * 0.07;
            const part = roundTok(
              Math.max(0, bot.posToken * pct),
              ctx.tokenDecimals(),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) {
                did = true;
              }
            }
          }
          if (!did && buysInRow > 0 && bot.posToken > 0 && !deferredSell) {
            const planned = roundTok(
              Math.max(
                bot.posToken * 0.04,
                bot.posToken * 0.03 + Math.random() * bot.posToken * 0.03,
              ),
              ctx.tokenDecimals(),
            );
            if (planned > 0) scheduleSell(planned, 1600, 3400);
          }
          break;
        }
        case "scalper": {
          if (
            !protect &&
            haveSol &&
            Math.abs(fast) > 0.0018 &&
            allocTok < MAX_ALLOC
          ) {
            const headroomVal = Math.max(
              0,
              (TARGET_ALLOC + 0.12) * total - bot.posToken * p,
            );
            const size = Math.min(Math.max(baseSize, pickStep()), headroomVal);
            if (size >= EXEC_MIN_SOL) {
              const bought = await twapBuy(size);
              if (bought) {
                did = true;
                break;
              }
            }
          }
          const wantSell = (() => {
            const avg = bot.avgSol || p;
            const r = (p - avg) / Math.max(1e-9, avg);
            return r >= 0.012 || r <= -0.005;
          })();
          if (wantSell || allocTok > MAX_ALLOC || protect) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(
                Math.max(bot.posToken * 0.12, (excessVal * 0.45) / p),
                ctx.tokenDecimals(),
              ),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) did = true;
            }
          } else if (bot.posToken > 0 && buysInRow >= 2) {
            const shave = roundTok(
              Math.max(
                bot.posToken * 0.06,
                bot.posToken * Math.random() * 0.08,
              ),
              ctx.tokenDecimals(),
            );
            if (shave > 0) {
              const sold = await trade("sell", 0, { sellTokens: shave });
              if (sold) did = true;
            }
          }
          break;
        }
        case "momentum": {
          if (
            !protect &&
            haveSol &&
            (fast > 0.001 || ch1m > 0.002) &&
            allocTok < MAX_ALLOC
          ) {
            const headroomVal = Math.max(
              0,
              (TARGET_ALLOC + 0.15) * total - bot.posToken * p,
            );
            const size = Math.min(
              Math.max(baseSize, pickStep() * 1.2),
              headroomVal,
            );
            if (size >= EXEC_MIN_SOL) {
              const bought = await twapBuy(size);
              if (bought) {
                did = true;
                break;
              }
            }
          }
          if (bot.posToken > 0 && trailHighPrice > 0) {
            const dd = (p - trailHighPrice) / Math.max(1e-9, trailHighPrice);
            if (dd < -0.009) {
              const part = roundTok(
                Math.max(
                  bot.posToken * 0.1,
                  bot.posToken * 0.06 + Math.random() * 0.06,
                ),
                ctx.tokenDecimals(),
              );
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) {
                did = true;
                break;
              }
            }
          }
          const want = (() => {
            const avg = bot.avgSol || p;
            const r = (p - avg) / Math.max(1e-9, avg);
            return r >= 0.015 || allocTok > MAX_ALLOC || protect;
          })();
          if (want) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(
                Math.max(bot.posToken * 0.18, (excessVal * 0.55) / p),
                ctx.tokenDecimals(),
              ),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) did = true;
            }
          }
          break;
        }
        case "range": {
          const mid = bot.avgSol || p;
          const dev = (p - mid) / Math.max(1e-9, mid);
          if (!protect && haveSol && dev < -0.01 && allocTok < MAX_ALLOC) {
            const size = Math.min(
              Math.max(baseSize, pickStep()),
              (TARGET_ALLOC + 0.1) * total,
            );
            if (size >= EXEC_MIN_SOL) {
              const bought = await twapBuy(size);
              if (bought) {
                did = true;
                break;
              }
            }
          }
          if (dev > 0.012 || allocTok > MAX_ALLOC || protect) {
            const part = roundTok(
              Math.max(bot.posToken * 0.12, (bot.posToken * dev) / 2),
              ctx.tokenDecimals(),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) did = true;
            }
          }
          break;
        }
        case "maker": {
          if (!protect && allocTok < MAX_ALLOC && haveSol) {
            const size = Math.min(pickStep() * 0.6, baseSize);
            if (Math.random() < 0.6 && size >= EXEC_MIN_SOL) {
              const bought = await twapBuy(size);
              if (bought) {
                did = true;
                break;
              }
            }
          }
          if (
            bot.posToken > 0 &&
            (allocTok > TARGET_ALLOC || protect || Math.random() < 0.35)
          ) {
            const part = roundTok(
              Math.max(bot.posToken * 0.07, bot.posToken * Math.random() * 0.1),
              ctx.tokenDecimals(),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) did = true;
            }
          } else if (!did && bot.posToken > 0 && !deferredSell) {
            const planned = roundTok(
              Math.max(
                bot.posToken * 0.03,
                bot.posToken * 0.02 + Math.random() * bot.posToken * 0.03,
              ),
              ctx.tokenDecimals(),
            );
            scheduleSell(planned, 1200, 2600);
          }
          break;
        }
      }

      if (!did) {
        // универсальное бритьё позиции для сглаживания
        if (bot.posToken > 0) {
          const sinceSell = Date.now() - (lastSellTs || 0);
          if (buysInRow >= 2 || sinceSell > Math.max(7000, bot.speedMs * 2)) {
            const shave = roundTok(
              Math.max(
                bot.posToken * 0.05,
                bot.posToken * 0.05 + Math.random() * bot.posToken * 0.04,
              ),
              ctx.tokenDecimals(),
            );
            if (shave > 0) {
              const sold = await trade("sell", 0, { sellTokens: shave });
              if (sold) {
                pending = false;
                const jitter = 200 + Math.floor(Math.random() * 300);
                return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
              }
            }
          }
        }
        const idleNow = Date.now();
          if (idleNow - lastIdleBalanceRefreshAt >= IDLE_BAL_REFRESH_MS) {
            try {
              await refreshOnChainBalances();
              ctx.setLightRefresh?.();
              ctx.afterTrade?.("idle");
              reportStats("idle");
            } catch {}
            lastIdleBalanceRefreshAt = Date.now();
          }
        bot.last = "hold";
        bot.unrealized = safeMultiply(
          bot.posToken || 0,
          (p || 0) - (bot.avgSol || p || 0),
        );
        pushUpdate({
          last: bot.last,
          unrealized: bot.unrealized,
          fills: bot.fills,
        });
      }
    } catch (e: any) {
      failStreak++;
      ctx.onFailStreak?.(failStreak);
      const cool = Math.min(20_000, 1000 * failStreak);
      nextRetryAt = Date.now() + cool;
      bot.lastError = e?.message || String(e);
      pushUpdate({ lastError: bot.lastError });
      const nextPf = bumpPriority(lastExecMeta.pf);
      const nextSlp = Math.min(MAX_SLP_BPS, lastExecMeta.slp + 15);
      warn(
        `net fail (${failStreak}) — ${bot.lastError}; backoff ${Math.round(cool / 1000)}s, next pf=${nextPf.toFixed(6)} slp=${nextSlp}`,
      );
      if (failStreak >= 6) {
        try {
          ctx.afterTrade?.("idle");
          reportStats("idle");
        } catch {}
      }
    } finally {
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      if (!stopped && !ctx.abortSignal?.aborted)
        setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }
  }
}
