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
type BotStrategy =
  | "trend"
  | "revert"
  | "scalper"
  | "momentum"
  | "range"
  | "maker";
type InternalStrategy = BotStrategy;

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
// Порядок попыток: same-origin → ваш API/прокси → публичный pumpportal
const PUMP_BASES: string[] = [""];
if (API_BASE) PUMP_BASES.push(`${API_BASE.replace(/\/+$/, "")}/x/pump`);
if (ALT_PUMP) PUMP_BASES.push(ALT_PUMP.replace(/\/+$/, ""));
PUMP_BASES.push("https://pumpportal.fun");

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
  // Абсолютные URL — ходим напрямую (без перебора баз)
  if (/^https?:\/\//i.test(path)) {
    return scheduleFetch(path, { ...(init as any), timeoutMs: 20_000, tries: 1 }, "pump");
  }
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
    const base = PUMP_BASES[idx] || "";
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
        // На 429/5xx/404 — пробуем следующую базу
        if (r.status === 429 || r.status >= 500 || r.status === 404) {
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
      // Сначала — те же origin ручки вашего приложения
      { path: "/api/trade-local", bin: true },
      { path: "/api/trade", bin: false },
      // Затем — то же самое, но через /x/pump на ваших прокси/бэкендах
      { path: "/x/pump/trade-local", bin: true },
      { path: "/x/pump/trade", bin: false },
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
const IDLE_BAL_REFRESH_MS = Math.max(
  10_000,
  Number((import.meta as any).env?.VITE_BOT_IDLE_REFRESH_MS ?? 45_000),
);

let TARGET_ALLOC = 0.7;
let MAX_ALLOC = 0.85;
let MIN_ALLOC = 0.6;

const MAX_TOTAL_DRAWDOWN = 0.25;
const MAX_SINGLE_TRADE_IMPACT = 0.012;
const MAX_ROUNDTRIP_LOSS = 0.006;

const MIN_SLP_BPS = 30;
const MAX_SLP_BPS = 120;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// endurance: force live
const FORCE_LIVE =
  String((import.meta as any).env?.VITE_FORCE_LIVE ?? "0") === "1";

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
        sellPct: 0.1,
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
        buySlice: 0.0005,
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
  // SELLALL-FIX: decimals cache that auto-updates from ctx
  let DEC = 9;
  const getDec = () => {
    try {
      const d = ctx.tokenDecimals?.();
      if (typeof d === "number" && d > 0 && d !== DEC) DEC = d;
    } catch {}
    return DEC;
  };

  let stopped = false;
  let pending = false;
  let cooldownUntil = 0;

  // endurance: heartbeat
  const HB_EVERY_MS = Math.max(
    1500,
    Number((import.meta as any).env?.VITE_BOT_HEARTBEAT_MS ?? 2000),
  );
  let lastHbAt = 0;

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

  let deferredSell: { dueAt: number; amountTok: number } | null = null;
  let lastIdleBalanceRefreshAt = Date.now();
    const priceHist: number[] = [];
    const stats = {
      since: Date.now(),
      buys: 0,
      sells: 0,
      slices: 0,
      skip: {
        corridor: 0,
        limits: 0,
        illiquid: 0,
        impact: 0,
        roundtrip: 0,
        cooldown: 0,
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
      corridor: 0,
      limits: 0,
      illiquid: 0,
      impact: 0,
      roundtrip: 0,
      cooldown: 0,
    });

    const resetStats = () => {
      stats.since = Date.now();
      stats.buys = 0;
      stats.sells = 0;
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
        `health: buys=${stats.buys} sells=${stats.sells} slices=${stats.slices}, skip: c=${skip.corridor} l=${skip.limits} i=${skip.illiquid} im=${skip.impact} rt=${skip.roundtrip} cd=${skip.cooldown}, quotes=${stats.quotesFail}, last pf=${lastExecMeta.pf.toFixed(6)} slp=${lastExecMeta.slp}, execMin=${EXEC_MIN_SOL.toFixed(
          6,
        )}`,
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

  function scheduleSell(amountTok: number, minMs: number, maxMs: number) {
    const now = Date.now();
    const delay = Math.max(
      0,
      minMs + Math.floor(Math.random() * Math.max(1, maxMs - minMs)),
    );
    deferredSell = { dueAt: now + delay, amountTok: Math.max(0, amountTok) };
  }

  async function refreshOnChainBalances() {
    try {
      const kp = ctx.keypair();
      const lam = await connection.getBalance(kp.publicKey, "processed");
      const sol = lam / LAMPORTS_PER_SOL;
      const raw = await getSPLBalance(connection, bot.pubkey, ctx.mint);
      const tok = Number(raw as any) / Math.pow(10, getDec());
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
      noLossFloorBps: 0, // по умолчанию не запрещаем продавать ниже avg — сценарий может поднять
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
    const decimals = getDec();
      const priceNow = priceNowSafe();
    const noLossMul =
      1 + Math.max(0, Number(risk.noLossFloorBps) || 0) / 10_000;

    let amountTok: number | undefined =
      side === "sell" && opts?.sellTokens
        ? roundTok(opts.sellTokens, decimals)
        : undefined;
    let minuteRetry = false;

    // жёсткий коридор до сборки сделки
    try {
      const { a, total } = alloc(priceNow);
      const EPS = 0.002;

        if (side === "buy" && a >= MAX_ALLOC - EPS) {
          noteSkip("corridor", "skip BUY: max allocation corridor");
          return false;
        }

        if (side === "sell" && a <= MIN_ALLOC + EPS) {
          // обычные продажи ниже коридора запрещаем (кроме принудительных sellTokens для комиссий)
          if (!opts?.sellTokens) {
            noteSkip("corridor", "skip SELL: min allocation corridor");
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
          if (clamped < execMin) {
            noteSkip("corridor", "skip BUY: clamped size below exec min");
            return false;
          }
        sizeSol = +clamped.toFixed(6);
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
              noteSkip("corridor", "skip SELL: clamp exhausted allocation");
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
              noteSkip("corridor", "skip SELL: clamp exhausted allocation");
              return false;
            }
          amountTok = capped;
        }
      }
    } catch {}

      if (side === "buy" && sizeSol < execMin) {
        noteSkip("limits", "skip BUY: below exec minimum");
        return false;
      }
      if (side === "sell" && (amountTok ?? bot.posToken) <= 0) {
        noteSkip("limits", "skip SELL: no size after clamp");
        return false;
      }

    // резерв SOL перед покупкой
    if (side === "buy") {
      const reserve = Math.max(MIN_KEEP_SOL, Number(risk.reserveSol) || 0);
      const stepCfg = (ctx as any).getTradeStep?.() ?? { minSol: 0.0002 };
      const need =
        reserve + Math.max(execMin, Number(stepCfg.minSol) || 0.0002);
        if ((bot.solBalance ?? 0) < need) {
          noteSkip("limits", "skip BUY: low SOL; scheduling tiny SELL for fees");
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
      if (nowTs < lossCooldownUntil) {
        noteSkip("cooldown", "skip BUY: loss cooldown");
        return false;
      }
      if (buysThisMin >= risk.maxBuysPerMin) {
        noteSkip("limits", "skip BUY: per-minute buy count");
        return false;
      }
      const maxNotional = Number(risk.maxNotionalPerMin) || 0;
      if (maxNotional > 0) {
        while (notionalThisMin + sizeSol > maxNotional) {
          if (minuteRetry) {
            noteSkip(
              "limits",
              `skip BUY: minute notional ${(notionalThisMin + sizeSol).toFixed(
                6,
              )} > ${maxNotional}`,
            );
            return false;
          }
          minuteRetry = true;
          sizeSol = +(sizeSol * 0.6).toFixed(6);
          if (sizeSol < execMin) {
            noteSkip("limits", "skip BUY: retry size fell below exec min");
            return false;
          }
        }
      }
    } else {
      if (sellsThisMin >= risk.maxSellsPerMin) {
        noteSkip("limits", "skip SELL: per-minute sell count");
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
    const fallbackActive = Date.now() < fallbackQuoteUntil;
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

    // sanity‑check Jupiter на покупку
    const quoteFn = (ctx as any).getJupiterQuote || getJupiterQuote;
    if (side === "buy") {
        try {
          const pay = Math.round(Math.max(execMin, sizeSol || pickStep()) * 1e9);
          const q = await quoteFn({
            inputMint: WSOL,
            outputMint: ctx.mint,
            amount: pay,
          });
          const fairOut = pay / 1e9 / priceNow;
          const out = Number(q?.outAmount || 0) / Math.pow(10, decimals);
          if (!isFinite(out) || out <= 0) {
            recordQuoteFailure();
            noteSkip("illiquid", "skip BUY: illiquid route");
            return false;
          }
          const maxImpact = Math.max(
            0,
            Math.min(0.2, Number(risk.maxImpact ?? MAX_SINGLE_TRADE_IMPACT)),
          );
          const impact = fairOut > 0 ? Math.max(0, 1 - out / fairOut) : 1;
          if (fairOut > 0 && impact > maxImpact) {
            noteSkip(
              "impact",
              `skip BUY: impact ${(impact * 100).toFixed(1)}% > ${(maxImpact * 100).toFixed(1)}%`,
            );
            return false;
          }

          const RT_SAMPLE = Math.min(
            1,
            Math.max(0, Number((import.meta as any).env?.VITE_RT_SAMPLE ?? 0.33)),
          );
          if (!fallbackActive && out > 0 && Math.random() < RT_SAMPLE) {
            try {
              const backRaw = Math.max(
                1,
                Math.round(out * Math.pow(10, decimals)),
              );
              const qb = await quoteFn({
                inputMint: ctx.mint,
                outputMint: WSOL,
                amount: backRaw,
              });
              const backSol = Number(qb?.outAmount || 0) / 1e9;
              const lossPct = Math.max(
                0,
                1 - backSol / Math.max(1e-12, pay / 1e9),
              );
              const maxRt = Math.max(
                0,
                Number((risk as any).maxRoundtripLoss ?? MAX_ROUNDTRIP_LOSS),
              );
              if (isFinite(lossPct) && lossPct > maxRt) {
                noteSkip(
                  "roundtrip",
                  `skip BUY: roundtrip ${(lossPct * 100).toFixed(1)}% > ${(maxRt * 100).toFixed(1)}%`,
                );
                return false;
              }
            } catch (e) {
              recordQuoteFailure();
            }
          }
        } catch (e) {
          recordQuoteFailure();
        }
    }

    // разбиение на срезы
    const caps = capsForStrategy(bot.strategy as InternalStrategy);
    let remainingSol = side === "buy" ? sizeSol || pickStep() : 0;
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
            noteSkip("limits", "skip BUY slice: per-minute buy count");
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
                  "limits",
                  "skip BUY slice: retry amount fell below exec min",
                );
                break;
              }
            }
            if (
              notionalThisMin + pl.amount >
              (Number(risk.maxNotionalPerMin) || 0)
            ) {
              noteSkip("limits", "skip BUY slice: minute notional");
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
              noteSkip("illiquid", "skip SELL: illiquid route");
              break;
            }
            const fair = qty * pnow;
            const thr = Math.max(
              0,
              Math.min(0.2, Number(risk.maxImpact ?? MAX_SINGLE_TRADE_IMPACT)),
            );
            let impact = fair > 0 ? Math.max(0, 1 - outSol / fair) : 0;

            if (impact > thr) {
              // одно «сжатие», затем второе — если всё ещё >thr, выходим
              const sh1 = roundTok(qty * 0.55, decimals);
              if (sh1 > 0 && sh1 < qty) {
                qty = sh1;
                // перезапрос для новой qty
                const raw2 = Math.max(
                  1,
                  Math.round(qty * Math.pow(10, decimals)),
                );
                const q2 = await quoteFn({
                  inputMint: ctx.mint,
                  outputMint: WSOL,
                  amount: raw2,
                });
                const out2 = Number(q2?.outAmount || 0) / 1e9;
                const imp2 =
                  qty * pnow > 0 ? Math.max(0, 1 - out2 / (qty * pnow)) : 0;
                if (imp2 > thr) {
                  noteSkip(
                    "impact",
                    `skip SELL: impact ${(imp2 * 100).toFixed(1)}% > ${(thr * 100).toFixed(1)}%`,
                  );
                  break;
                }
              } else {
                noteSkip(
                  "impact",
                  `skip SELL: impact ${(impact * 100).toFixed(1)}% > ${(thr * 100).toFixed(1)}%`,
                );
                break;
              }
            }
          } catch {
            recordQuoteFailure();
            noteSkip("illiquid", "skip SELL: quote fetch failed");
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
            noteSkip("limits", "skip SELL slice: per-minute sell count");
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
      if (side === "buy") stats.buys++;
      else stats.sells++;
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
  return () => {
    stopped = true;
    const shouldLog = ctx.shouldLogStop?.() ?? true;
    if (shouldLog) {
      log("info", "runner: stopped");
    }
  };

  async function loop() {
    if (stopped || !bot.running || ctx.abortSignal?.aborted) return;
    if (pending) return;

      const now = Date.now();
      if (now - lastHbAt >= HB_EVERY_MS) {
        lastHbAt = now;
        try {
          ctx.onUpdate({ id: bot.id, hb: now } as any);
        } catch {}
      }
    if (now < nextRetryAt) {
      setTimeout(loop, Math.max(200, nextRetryAt - now));
      return;
    }
    if (now < cooldownUntil) {
      setTimeout(loop, Math.max(50, cooldownUntil - now));
      return;
    }

      if (lossCooldownUntil && now >= lossCooldownUntil) {
        log("info", "loss cooldown ended");
        lossCooldownUntil = 0;
      }

      const p = priceNowSafe();

      // endurance: cooldown unfreeze on momentum+recovery
      if (lossCooldownUntil) {
        let thr = 0.004;
        try {
          const rawThr = Number(ctx.getRisk?.().lossThrPct);
          thr = Math.max(0, Number.isFinite(rawThr) ? rawThr : 0.004);
        } catch {}
        if (lastBuyAtPrice && thr > 0) {
          const recovered = p >= lastBuyAtPrice * (1 - thr / 2);
          const momentum = Math.abs(ctx.changeFast?.(8) || 0) > 0.005;
          if (momentum && recovered) {
            lossCooldownUntil = 0;
            log("info", "loss cooldown cleared (momentum+recovery)");
          }
        }
      }

    // выполнить отложенную маленькую продажу (для комиссий/сглаживания)
    if (deferredSell && now >= deferredSell.dueAt && bot.posToken > 0) {
      pending = true;
      let executedDeferred = false;
      let attemptedQty = 0;
      try {
        if (now - (lastBuyTs || 0) < 8000) {
          deferredSell = null;
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
        const capPct = Math.min(0.5, Math.max(0.005, 0.035));
        const capTok = roundTok(bot.posToken * capPct, getDec());
        const qty = Math.min(
          capTok,
          Math.min(bot.posToken * 0.2, Math.max(0, deferredSell.amountTok)),
        );
        if (qty > 0) {
          attemptedQty = qty;
          executedDeferred = await trade("sell", 0, { sellTokens: qty });
        }
      } catch {}
        if (!executedDeferred && attemptedQty > 0) {
          const retryDelay =
            Math.max(800, bot.speedMs) + Math.floor(Math.random() * 400);
          deferredSell = {
            dueAt: Date.now() + retryDelay,
            amountTok: attemptedQty,
          };
      } else {
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

        if (!FORCE_LIVE && ctx.isAiPaused && ctx.isAiPaused()) {
          bot.last = "ai:off";
          pushUpdate({ last: bot.last });
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }

      priceHist.push(p);
      if (priceHist.length > 120) priceHist.shift();
    const fast = ctx.changeFast?.(12) ?? 0;
    const ch1m = ctx.change1m();
    const volScore = Math.max(Math.abs(fast), Math.abs(ch1m));

      const { a: allocTok, total } = alloc(p);
      const portfolioNow = bot.solBalance + bot.posToken * p;
      if (baselineValue === 0) baselineValue = portfolioNow;

      let risk: any = ctx.getRisk?.() || {};
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
          Math.min(bot.posToken * 0.22, needSol / Math.max(1e-12, p)),
          getDec(),
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

      // пред‑стратегическая авто‑ребалансировка
      if (bot.posToken > 0 && allocTok > MAX_ALLOC + eps) {
        const desiredTokVal = TARGET_ALLOC * total;
        const currentTokVal = bot.posToken * p;
        const excessVal = Math.max(0, currentTokVal - desiredTokVal);
        const over = allocTok - MAX_ALLOC;
        const factor = over > 0.03 ? 1.0 : over > 0.015 ? 0.75 : 0.5;
        const tokToSell = Math.min(
          bot.posToken,
          roundTok(
            Math.max(bot.posToken * 0.12, (excessVal * factor) / p),
            getDec(),
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
            getDec(),
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
                getDec(),
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
                getDec(),
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
                getDec(),
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
              getDec(),
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
              getDec(),
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
              getDec(),
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
              let part = Math.min(
                bot.posToken,
                roundTok(
                  Math.max(bot.posToken * 0.12, (excessVal * 0.45) / p),
                  getDec(),
                ),
              );
              const maxSlice = roundTok(
                Math.max(0, bot.posToken * (0.2 + Math.random() * 0.05)),
                getDec(),
              );
              if (maxSlice > 0) part = Math.min(part, maxSlice);
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
              getDec(),
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
                getDec(),
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
                getDec(),
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
              getDec(),
            );
            if (part > 0) {
              const sold = await trade("sell", 0, { sellTokens: part });
              if (sold) did = true;
            }
          }
          break;
        }
        case "maker": {
            const shortVol = Math.abs(fast);
            const buyProb = Math.min(
              0.6,
              0.2 + shortVol * 6 + Math.max(0, fast) * 4 + volScore * 2,
            );
            const sellProb = Math.min(
              0.6,
              0.2 + volScore * 4 + Math.max(0, -fast) * 6,
            );
            if (!protect && allocTok < MAX_ALLOC && haveSol) {
              const size = Math.min(pickStep() * 0.6, baseSize);
              if (size >= EXEC_MIN_SOL && Math.random() < buyProb) {
                const bought = await twapBuy(size);
                if (bought) {
                  did = true;
                  break;
                }
              }
            }
            const wantMakerSell =
              allocTok > TARGET_ALLOC || protect || Math.random() < sellProb;
            if (bot.posToken > 0 && wantMakerSell) {
              const part = roundTok(
                Math.max(bot.posToken * 0.07, bot.posToken * Math.random() * 0.1),
                getDec(),
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
                getDec(),
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
              const minShave = bot.posToken * 0.03;
              const maxShave = bot.posToken * 0.07;
              const rawShave =
                minShave + Math.random() * Math.max(0, maxShave - minShave);
              const shave = roundTok(rawShave, getDec());
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
