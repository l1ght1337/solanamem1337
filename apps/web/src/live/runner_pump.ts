// apps/web/src/live/runner_pump.ts
import {
  Connection,
  VersionedTransaction,
  PublicKey,
  Keypair,
} from "@solana/web3.js";

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

const PUMP_BASE = "https://pumpportal.fun";

async function buildTradeTxPumpPortal(
  payload: Record<string, any>
): Promise<VersionedTransaction> {
  const r = await fetch(`${PUMP_BASE}/api/trade-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
    keepalive: true,
    cache: "no-store",
  });

  const ct = r.headers.get("content-type") || "";
  if (!r.ok && !ct.includes("application/json")) {
    const txt = await r.text().catch(() => "");
    throw new Error(`pumpportal ${r.status}: ${txt || "Bad Request"}`);
  }

  if (ct.includes("application/octet-stream")) {
    const raw = new Uint8Array(await r.arrayBuffer());
    return VersionedTransaction.deserialize(raw);
  }

  const j = await r.json().catch(() => ({}));
  const b64 = j?.serializedTransaction || j?.tx || j?.transaction || j?.vtx || null;
  if (!b64) throw new Error("pumpportal: no transaction in response");

  const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
  return VersionedTransaction.deserialize(raw);
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

function roundTok(tokens: number, decimals: number) {
  const p = Math.pow(10, Math.min(6, decimals));
  return Math.max(0, Math.floor(tokens * p) / p);
}

function wantToSell(
  bot: LiveBot,
  currPrice: number,
  takeProfitBps: number,
  stopLossBps: number
) {
  if (bot.posToken <= 0 || !bot.avgSol) return false;
  const chg = (currPrice - bot.avgSol) / Math.max(1e-9, bot.avgSol);
  if (chg >= takeProfitBps / 10_000) return true;
  if (chg <= -stopLossBps / 10_000) return true;
  return false;
}

export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;
  let cooldownUntil = 0;

  // backoff при сетевых фейлах
  let failStreak = 0;
  let nextRetryAt = 0;

  const log = (lvl: "info" | "ok" | "warn" | "err", s: string) =>
    ctx.onLog(lvl, `[${bot.name}] ${s}`);

  async function trade(side: "buy" | "sell", sizeSol: number) {
    const kp = ctx.keypair();
    const decimals = ctx.tokenDecimals();
    const priceNow = Math.max(1e-12, ctx.price());

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
            amount: roundTok(bot.posToken, decimals),
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          };

    // сетевой флоу с ловлей «Failed to fetch» и бэкоффом
    try {
      const vtx = await buildTradeTxPumpPortal(payload);
      vtx.sign([kp]);

      const sig = await connection.sendTransaction(vtx, {
        skipPreflight: false,
        maxRetries: 3,
      });
      await connection.confirmTransaction(sig, "confirmed");

      // успех — сбрасываем backoff
      failStreak = 0;
      nextRetryAt = 0;

      if (side === "buy") {
        const qty = sizeSol / priceNow;
        const newPos = bot.posToken + qty;
        bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + sizeSol) / newPos : priceNow;
        bot.posToken = newPos;
      } else {
        const sellQty = bot.posToken;
        bot.realized += (priceNow - (bot.avgSol || priceNow)) * sellQty;
        bot.posToken = 0;
        bot.avgSol = 0;
      }
      bot.unrealized = bot.posToken * (priceNow - (bot.avgSol || priceNow));
      bot.fills += 1;
      bot.last = `${side} ${side === "buy" ? sizeSol.toFixed(4) + " SOL" : "ALL"} @ slp=${ctx.slippageBps().toFixed(0)}bps`;

      ctx.onUpdate(bot);
      log("ok", `${side.toUpperCase()} ${sig.slice(0, 8)}…`);

      cooldownUntil = Date.now() + Math.max(1200, bot.speedMs);
    } catch (e: any) {
      failStreak++;
      const cool = Math.min(20_000, 1_000 * failStreak); // 1s → 20s
      nextRetryAt = Date.now() + cool;

      bot.lastError = e?.message || String(e);
      ctx.onUpdate(bot);
      log("warn", `net fail (${failStreak}) — ${bot.lastError}; retry in ${Math.round(cool / 1000)}s`);
    }
  }

  async function loop() {
    if (stopped || !bot.running) return;
    if (pending) return;

    const now = Date.now();
    // если отложенный ретрай — ждём
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
      // пауза AI из UI
      if (ctx.isAiPaused && ctx.isAiPaused()) {
        bot.last = "ai:off";
        ctx.onUpdate(bot);
        pending = false;
        return setTimeout(loop, Math.max(400, bot.speedMs));
      }

      const p = Math.max(1e-12, ctx.price());
      const fast = (ctx.changeFast?.(12) ?? 0);
      const ch1m = ctx.change1m();

      const baseSize = Math.max(0.0002, Math.min(bot.budgetSol || ctx.tradeSize(), bot.solBalance - 0.0003));
      const haveSol = bot.solBalance > 0.0006;

      let did = false;

      switch (bot.strategy) {
        case "trend": {
          if (haveSol && fast > 0.002 && ch1m >= 0) {
            await trade("buy", baseSize);
            did = true;
            break;
          }
          if (wantToSell(bot, p, 800, 400)) {
            await trade("sell", 0);
            did = true;
          }
          break;
        }
        case "revert": {
          if (haveSol && fast < -0.004) {
            await trade("buy", baseSize);
            did = true;
            break;
          }
          if (wantToSell(bot, p, 70, 35)) {
            await trade("sell", 0);
            did = true;
          }
          break;
        }
        case "scalper": {
          if (haveSol && Math.abs(fast) > 0.0022) {
            await trade("buy", baseSize);
            did = true;
            break;
          }
          if (wantToSell(bot, p, 120, 55)) {
            await trade("sell", 0);
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

  setTimeout(loop, 10);
  return () => { stopped = true; };
}
