import {
  Connection,
  VersionedTransaction,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { getSPLBalance } from "../utils/solana";

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
// prefer your backend → custom pump API → public pump portal
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const ALT_PUMP = ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, "");
const PUMP_BASES = [API_BASE ? `${API_BASE}/x/pump` : "", ALT_PUMP, "https://pumpportal.fun"].filter(Boolean);

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
        const r = await withTimeout(fetch(url, {
          keepalive: true,
          credentials: "omit",
          cache: "no-store",
          mode: "cors",
          ...init,
          headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
        }), 20_000);

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

  // per-bot backoff if trade building fails
  let failStreak = 0;
  let nextRetryAt = 0;
  let lastWarnTs = 0;

  const log = (lvl: "info" | "ok" | "warn" | "err", s: string) => ctx.onLog(lvl, `[${bot.name}] ${s}`);
  const warnDebounced = (s: string) => {
    const now = Date.now();
    if (now - lastWarnTs > 2000) { lastWarnTs = now; log("warn", s); }
  };

  const alloc = (priceNow: number) => {
    const tokVal = bot.posToken * priceNow;
    const total = Math.max(1e-9, tokVal + bot.solBalance);
    return { tokVal, total, a: tokVal / total };
  };

  async function refreshOnChainBalances() {
    try {
      const kp = ctx.keypair();
      const lam = await connection.getBalance(kp.publicKey, "processed");
      const sol = lam / LAMPORTS_PER_SOL;
      const raw = await getSPLBalance(connection, bot.pubkey, ctx.mint);
      const tok = Number(raw as any) / Math.pow(10, ctx.tokenDecimals());
      bot.solBalance = sol;
      bot.tokenBalance = tok;
      ctx.onUpdate(bot);
    } catch { /* soft */ }
  }

  async function trade(
    side: "buy" | "sell",
    sizeSol: number,
    opts?: { sellTokens?: number }
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
            amount: amountTok ?? roundTok(bot.posToken, decimals),
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          };

    try {
      const vtx = await buildTradeTxPumpPortal(payload);
      vtx.sign([kp]);

      const sig = await connection.sendRawTransaction(vtx.serialize(), {
        skipPreflight: false,
        maxRetries: 4,
      });
      await connection.confirmTransaction(sig, "confirmed");

      // success → reset backoff
      failStreak = 0;
      nextRetryAt = 0;

      // optimistic local portfolio update
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

      // force on-chain refresh for this bot
      await refreshOnChainBalances();

      cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
    } catch (e: any) {
      failStreak++;
      const cool = Math.min(20000, 1000 * failStreak); // 1s → 20s
      nextRetryAt = Date.now() + cool;

      bot.lastError = e?.message || String(e);
      ctx.onUpdate(bot);
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

  // desync start a bit across bots
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

    pending = true;
    try {
      // periodic light on-chain refresh (keeps UI in sync even without trades)
      if (now - lastLightRefresh > 15000) {
        await refreshOnChainBalances();
        lastLightRefresh = now;
      }

      if (ctx.isAiPaused && ctx.isAiPaused()) {
        bot.last = "ai:off";
        ctx.onUpdate(bot);
        pending = false;
        const jitter = 200 + Math.floor(Math.random() * 300);
        return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
      }

      const p = Math.max(1e-12, ctx.price());
      const fast = ctx.changeFast?.(12) ?? 0;
      const ch1m = ctx.change1m();

      const { a: allocTok, total } = alloc(p);

      const baseSize = Math.max(
        0.00015,
        Math.min(bot.budgetSol || ctx.tradeSize(), bot.solBalance - (MIN_KEEP_SOL + 0.00015))
      );
      const haveSol = bot.solBalance > MIN_KEEP_SOL + 0.00015;

      /* ======= pre-strategy auto-rebalance ======= */
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
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      if (haveSol && allocTok < MIN_ALLOC) {
        const targetVal = TARGET_ALLOC * total;
        const needVal = Math.max(0, targetVal - bot.posToken * p);
        const buySol = Math.max(0, Math.min(baseSize, needVal));
        if (buySol > 0.00012) {
          await twapBuy(buySol);
          pending = false;
          const jitter = 200 + Math.floor(Math.random() * 300);
          return setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
        }
      }

      /* ================== strategies ================== */
      let did = false;

      switch (bot.strategy) {
        case "trend": {
          if (haveSol && fast > 0.0009 && ch1m > -0.0005 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
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
          if (haveSol && fast < -0.0015 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.1) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.00012) { await twapBuy(size); did = true; break; }
          }
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
          if (haveSol && Math.abs(fast) > 0.0022 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.0001) { await twapBuy(size); did = true; break; }
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
      warnDebounced(String(e?.message || e));
    } finally {
      pending = false;
      const jitter = 200 + Math.floor(Math.random() * 300);
      if (!stopped) setTimeout(loop, Math.max(400, bot.speedMs) + jitter);
    }
  }
}
