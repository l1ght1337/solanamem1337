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
const FEE_EST_SOL = 0.00002;     // грубая оценка комиссии
const MIN_KEEP_SOL = 0.0006;     // резерв, чтобы не сесть «в ноль»
const TARGET_ALLOC = 0.5;        // целевая доля токена в портфеле (по цене)
const MAX_ALLOC = 0.75;          // не держим >75% в токене
const MIN_ALLOC = 0.25;          // и не уходим <25% при наличии позиции

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

  /** текущая аллокация токена от всего портфеля по mark-to-market */
  const alloc = (priceNow: number) => {
    const tokVal = bot.posToken * priceNow;
    const total = Math.max(1e-9, tokVal + bot.solBalance);
    return { tokVal, total, a: tokVal / total };
  };

  async function trade(side: "buy" | "sell", sizeSol: number, opts?: { sellTokens?: number }) {
    const kp = ctx.keypair();
    const decimals = ctx.tokenDecimals();
    const priceNow = Math.max(1e-12, ctx.price());

    // подсказка для частичных продаж
    const amountTok = side === "sell" && opts?.sellTokens ? roundTok(opts.sellTokens, decimals) : undefined;

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
            amount: amountTok ?? roundTok(bot.posToken, decimals), // по умолчанию — ALL
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          };

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

      // оптимистичное обновление портфеля
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
      bot.last = `${side} ${side === "buy" ? sizeSol.toFixed(4) + " SOL" : (amountTok ? `${amountTok} TOK` : "ALL")} @ slp=${ctx.slippageBps().toFixed(0)}bps`;

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

      // портфельная аллокация
      const { a: allocTok, total } = alloc(p);

      // лимиты покупки и базовый размер
      const baseSize = Math.max(0.0002, Math.min(bot.budgetSol || ctx.tradeSize(), bot.solBalance - 0.0003));
      const haveSol = bot.solBalance > MIN_KEEP_SOL;

      // расчет частичных продаж «к цели»
      const sellToTarget = () => {
        if (bot.posToken <= 0) return 0;
        const desiredTokVal = TARGET_ALLOC * total;
        const currentTokVal = bot.posToken * p;
        const excessVal = Math.max(0, currentTokVal - desiredTokVal);
        // разгружаем ~60% избыточной доли, но не менее 20% позиции
        const tok = Math.max(bot.posToken * 0.2, excessVal * 0.6 / p);
        return Math.min(bot.posToken, roundTok(tok, ctx.tokenDecimals()));
      };

      let did = false;

      switch (bot.strategy) {
        case "trend": {
          // buy: импульс вверх и положительная минутная дельта, но не уходим выше MAX_ALLOC
          if (haveSol && fast > 0.0018 && ch1m >= 0 && allocTok < MAX_ALLOC) {
            // ограничим так, чтобы после сделки ток-доля не превысила (TARGET_ALLOC + 0.15)
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const limitByAlloc = Math.max(0, headroomVal);
            const size = Math.min(baseSize, limitByAlloc);
            if (size > 0.00015) {
              await trade("buy", size);
              did = true;
              break;
            }
          }
          // sell: TP 7%, SL 4%, но частично — к цели
          if (wantToSell(bot, p, 700, 400) || allocTok > MAX_ALLOC) {
            const part = sellToTarget();
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "revert": {
          // buy: на сильной краткосрочной просадке, но не уходим ниже MIN_KEEP_SOL и не заходим >MAX_ALLOC
          if (haveSol && fast < -0.0045 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.10) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.00015) {
              await trade("buy", size);
              did = true;
              break;
            }
          }
          // sell: маленький TP/SL, частично
          if (wantToSell(bot, p, 80, 40) || allocTok > MAX_ALLOC) {
            const part = sellToTarget();
            await trade("sell", 0, { sellTokens: part > 0 ? part : undefined });
            did = true;
          }
          break;
        }

        case "scalper": {
          // хапаем импульсы в обе стороны, но уважаем аллокацию
          if (haveSol && Math.abs(fast) > 0.0022 && allocTok < MAX_ALLOC) {
            const headroomVal = Math.max(0, (TARGET_ALLOC + 0.15) * total - bot.posToken * p);
            const size = Math.min(baseSize, headroomVal);
            if (size > 0.00012) {
              await trade("buy", size);
              did = true;
              break;
            }
          }
          if (wantToSell(bot, p, 120, 55) || allocTok > MAX_ALLOC) {
            const part = sellToTarget();
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

  setTimeout(loop, 10);
  return () => { stopped = true; };
}
