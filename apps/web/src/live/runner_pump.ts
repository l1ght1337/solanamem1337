// apps/web/src/live/runner_pump.ts
import { Connection, VersionedTransaction, Keypair } from "@solana/web3.js";

/* ───────────────────────────── Types ───────────────────────────── */
type BotStrategy = "trend" | "revert" | "scalper";

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
};

/* ─────────────────────── Net bases & utilities ─────────────────────── */
// Prefer your backend → custom pump API → public pump portal
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const ALT_PUMP = ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, "");
const PUMP_BASES = [API_BASE ? `${API_BASE}/x/pump` : "", ALT_PUMP, "https://pumpportal.fun"].filter(Boolean);

// Global queue to avoid spamming the pump API from many bots at once
const globalNetQueue: { p: Promise<any> } =
  (window as any).__pumpQueue || ((window as any).__pumpQueue = { p: Promise.resolve() });

function queueNet<T>(fn: () => Promise<T>) {
  // ~120–220ms spacing between *all* trade-build requests
  const gap = 120 + Math.floor(Math.random() * 100);
  const run = () =>
    fn().then(async (v) => {
      await new Promise((r) => setTimeout(r, gap));
      return v;
    });
  globalNetQueue.p = globalNetQueue.p.then(run, run);
  return globalNetQueue.p as Promise<T>;
}

function withTimeout<T>(p: Promise<T>, ms = 15000): Promise<T> {
  let t: number;
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error("fetch timeout")), ms) as unknown as number;
    t = timer;
    p.then(
      (v) => {
        clearTimeout(t);
        resolve(v);
      },
      (e) => {
        clearTimeout(t);
        reject(e);
      }
    );
  });
}

async function fetchFirstOk(path: string, init: RequestInit = {}, retries = 2) {
  let lastErr: any;
  for (const base of PUMP_BASES) {
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      // light exponential backoff + jitter
      const backoff = 300 * attempt + Math.floor(Math.random() * 250);
      try {
        const r = await withTimeout(
          fetch(url, {
            keepalive: true,
            credentials: "omit",
            cache: "no-store",
            mode: "cors",
            ...init,
            headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
          }),
          15000
        );

        if (r.ok) return r;

        // retry on 429/5xx
        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`${r.status} ${r.statusText}`);
          await new Promise((res) => setTimeout(res, backoff));
          continue;
        }

        const txt = await r.text().catch(() => "");
        throw new Error(`${r.status} ${r.statusText}${txt ? `: ${txt}` : ""}`);
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, backoff));
      }
    }
  }
  throw lastErr || new Error("All pump endpoints failed");
}

/** Build Versioned TX via pump portal with fallback & global throttling */
async function buildTradeTxPumpPortal(payload: Record<string, any>): Promise<VersionedTransaction> {
  return queueNet(async () => {
    const attempts: Array<{ path: string; binary: boolean }> = [
      { path: "/api/trade-local", binary: true }, // prefer binary stream
      { path: "/api/trade", binary: false }, // JSON fallback
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

        const j = await r.json().catch(() => ({} as any));
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
const FEE_EST_SOL = 0.00002; // ≈ 20k lamports
const MIN_KEEP_SOL = 0.0006; // keep small SOL reserve

// allocation targets (by mark-to-market value)
const TARGET_ALLOC = 0.55;
const MAX_ALLOC = 0.8;
const MIN_ALLOC = 0.2;

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

  // network backoff if trade-building fails repeatedly
  let failStreak = 0;
  let nextRetryAt = 0;

  const log = (lvl: "info" | "ok" | "warn" | "err", s: string) => ctx.onLog(lvl, `[${bot.name}] ${s}`);

  /** token allocation against whole portfolio value */
  const alloc = (priceNow: number) => {
    const tokVal = bot.posToken * priceNow;
    const total = Math.max(1e-9, tokVal + bot.solBalance);
    return { tokVal, total, a: tokVal / total };
  };

  async function trade(
    side: "buy" | "sell",
    sizeSol: number,
    opts?: { sellTokens?: number } // partial sell amount (tokens)
  ) {
    const kp = ctx.keypair();
    const decimals = ctx.tokenDecimals();
    const priceNow = Math.max(1e-12, ctx.price());

    const amountTok =
      side === "sell" && opts?.sellTokens ? roundTok(opts.sellTokens, decimals) : undefined;

    if (side === "buy" && sizeSol <= 0) return;
    if (side === "sell" && (amountTok ?? bot.posToken) <= 0) return;

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
            amount: amountTok ?? roundTok(bot.posToken, decimals), // default: sell ALL
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          };

    try {
      const vtx = await buildTradeTxPumpPortal(payload);
      vtx.sign([kp]);

      const sig = await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
      await connection.confirmTransaction(sig, "confirmed");

      // reset per-bot backoff after success
      failStreak = 0;
      nextRetryAt = 0;

      // optimistic portfolio update (no on-chain reads)
      if (side === "buy") {
        const qty = sizeSol / priceNow;
        const newPos = bot.posToken + qty;
        bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + sizeSol) / newPos : priceNow;
        bot.posToken = newPos;
        bot.solBalance = Math.max(0, (bot.solBalance ?? 0) - sizeSol - FEE_EST_SOL);
        bot.tokenBalance = bot.posToken;
      } else {
        const sellQty = amountTok ?? bot.posToken;
        bot.realized += (priceNow - (bot.avgSol || priceNow)) * sellQty;
        bot.posToken = Math.max(0, bot.posToken - sellQty);
        bot.avgSol = bot.posToken > 0 ? bot.avgSol : 0;
        bot.solBalance = Math.max(0, (bot.solBalance ?? 0) + Math.max(0, sellQty * priceNow - FEE_EST_SOL));
        bot.tokenBalance = bot.posToken;
      }

      bot.unrealized = bot.posToken * (priceNow - (bot.avgSol || priceNow));
      bot.fills += 1;
      bot.last =
        side === "buy"
          ? `buy ${sizeSol.toFixed(4)} SOL @ slp=${ctx.slippageBps().toFixed(0)}bps`
          : `sell ${opts?.sellTokens ? roundTok(opts.sellTokens, decimals) + " TOK" : "ALL"} @ slp=${ctx
              .slippageBps()
              .toFixed(0)}bps`;

      ctx.onUpdate(bot);
      log("ok", `${side.toUpperCase()} ${sig.slice(0, 8)}…`);

      cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
    } catch (e: any) {
      failStreak++;
      const cool = Math.min(20000, 1000 * failStreak); // 1s → 20s
      nextRetryAt = Date.now() + cool;

      bot.lastError = e?.message || String(e);
      ctx.onUpdate(bot);
      log("warn", `net fail (${failStreak}) — ${bot.lastError}; retry in ${Math.round(cool / 1000)}s`);
    }
  }

  /** Split big buy into TWAP slices if configured */
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

  setTimeout(loop, 10);
  return () => {
    stopped = true;
  };

  async function loop() {
    if (stopped || !bot.running) return;
    if (pending) return;

    const now = Date.now();

    // scheduled retry after prior net fail
    if (now < nextRetryAt) {
      setTimeout(loop, Math.max(200, nextRetryAt - now));
      return;
    }
    // cool-down after trade
    if (now < cooldownUntil) {
      setTimeout(loop, Math.max(50, cooldownUntil - now));
      return;
    }

    pending = true;
    try {
      // AI pause
      if (ctx.isAiPaused && ctx.isAiPaused()) {
        bot.last = "ai:off";
        ctx.onUpdate(bot);
        pending = false;
        return setTimeout(loop, Math.max(400, bot.speedMs));
      }

      const p = Math.max(1e-12, ctx.price());
      const fast = ctx.changeFast?.(12) ?? 0; // ~12s impulse
      const ch1m = ctx.change1m();

      // portfolio metrics
      const { a: allocTok, total } = alloc(p);

      // base size (respect SOL reserve)
      const baseSize = Math.max(
        0.00015,
        Math.min(bot.budgetSol || ctx.tradeSize(), bot.solBalance - (MIN_KEEP_SOL + 0.00015))
      );
      const haveSol = bot.solBalance > MIN_KEEP_SOL + 0.00015;

      /* ======= Pre-strategy auto-rebalance ======= */

      // too much token → trim toward target
      if (bot.posToken > 0 && allocTok > MAX_ALLOC) {
        const desiredTokVal = TARGET_ALLOC * total;
        const currentTokVal = bot.posToken * p;
        const excessVal = Math.max(0, currentTokVal - desiredTokVal);
        const tokToSell = Math.min(
          bot.posToken,
          roundTok(Math.max(bot.posToken * 0.2, (excessVal * 0.6) / p), ctx.tokenDecimals())
        );
        if (tokToSell > 0) {
          await trade("sell", 0, { sellTokens: tokToSell });
          pending = false;
          return setTimeout(loop, Math.max(400, bot.speedMs));
        }
      }

      // too little token and we have SOL → buy toward target
      if (haveSol && allocTok < MIN_ALLOC) {
        const targetVal = TARGET_ALLOC * total;
        const needVal = Math.max(0, targetVal - bot.posToken * p);
        const buySol = Math.max(0, Math.min(baseSize, needVal));
        if (buySol > 0.00012) {
          await twapBuy(buySol);
          pending = false;
          return setTimeout(loop, Math.max(400, bot.speedMs));
        }
      }

      /* ================== Strategies ================== */
      let did = false;

      switch (bot.strategy) {
        case "trend": {
          // be more active: small negative 1m acceptable, lower fast threshold
          if (haveSol && fast > 0.0009 && ch1m > -0.0005 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.00012) {
              await twapBuy(size);
              did = true;
              break;
            }
          }
          // TP/SL or over-allocated → partial trim to target
          if (wantToSell(bot, p, 700, 400) || allocTok > MAX_ALLOC) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.2, (excessVal * 0.6) / p), ctx.tokenDecimals())
            );
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "revert": {
          // buy aggressive dips
          if (haveSol && fast < -0.0015 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.1) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.00012) {
              await twapBuy(size);
              did = true;
              break;
            }
          }
          // small TP/SL or over-allocated → trim
          if (wantToSell(bot, p, 80, 40) || allocTok > MAX_ALLOC) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.2, (excessVal * 0.6) / p), ctx.tokenDecimals())
            );
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "scalper": {
          // impulse both ways, respect allocation
          if (haveSol && Math.abs(fast) > 0.0022 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.0001) {
              await twapBuy(size);
              did = true;
              break;
            }
          }
          if (wantToSell(bot, p, 120, 55) || allocTok > MAX_ALLOC) {
            const desiredTokVal = TARGET_ALLOC * total;
            const excessVal = Math.max(0, bot.posToken * p - desiredTokVal);
            const part = Math.min(
              bot.posToken,
              roundTok(Math.max(bot.posToken * 0.2, (excessVal * 0.6) / p), ctx.tokenDecimals())
            );
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }
      }

      if (!did) {
        bot.last = "hold";
        bot.unrealized = bot.posToken * (p - (bot.avgSol || p));
        ctx.onUpdate(bot);
      }
    } catch (e: any) {
      bot.lastError = e?.message || String(e);
      ctx.onUpdate(bot);
      log("warn", bot.lastError);
    } finally {
      pending = false;
      if (!stopped) setTimeout(loop, Math.max(400, bot.speedMs));
    }
  }
}
