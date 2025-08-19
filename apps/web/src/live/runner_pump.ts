// apps/web/src/live/runner_pump.ts
import { Connection, VersionedTransaction, PublicKey, Keypair } from "@solana/web3.js";

/** ----- типы из Store (минимально нужные) ----- */
export type LiveBot = {
  id: string;
  name: string;
  strategy: "trend" | "revert" | "scalper";
  budgetSol: number;
  speedMs: number;
  running: boolean;
  aiEnabled: boolean;
  manualLock?: boolean;
  keyId: string;
  pubkey: string;

  solBalance: number;
  tokenBalance: number;

  // позиция/PNL
  posToken: number;
  avgSol: number;
  realized: number;
  unrealized: number;

  fills: number;
  last?: string;
  lastError?: string;
};

export type RunCtx = {
  mint: string;
  slippageBps: () => number;
  twap?: { slices: number; gapMs: number } | null;

  price: () => number;
  changeFast: (secs?: number) => number; // быстрая дельта (мы в startBot её уже прокинули)
  change1m: () => number;

  keypair: () => Keypair;
  tokenDecimals: () => number;
  tradeSize: () => number;

  onLog: (level: "ok" | "warn" | "err" | "info", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
};

/** ----- прямой вызов pumpportal.fun ----- */
const PUMP_BASE = "https://pumpportal.fun";

async function buildTradeTxPumpPortal(payload: Record<string, any>): Promise<VersionedTransaction> {
  const r = await fetch(`${PUMP_BASE}/api/trade-local`, {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
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
  const b64 = j?.serializedTransaction || j?.tx || j?.transaction || j?.vtx;
  if (!b64) throw new Error("pumpportal: no transaction in response");
  const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
  return VersionedTransaction.deserialize(raw);
}

/** ----- полезности ----- */
function jitter(ms: number) {
  const j = Math.floor((Math.random() * 2 - 1) * Math.min(600, ms * 0.3));
  return Math.max(0, ms + j);
}

function clamp(n: number, a: number, b: number) {
  return Math.min(b, Math.max(a, n));
}

/** ===== основной раннер ===== */
export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;
  let lastFillTs = 0;

  // «человечность»
  const minSolLeft = 0.00025;      // минимум оставить на комиссии
  const baseCooldown = 2500;       // базовый cooldown между сделками

  // TP/SL в bps
  const TAKE_PROFIT_BPS = 800;     // +8%
  const STOP_LOSS_BPS   = 450;     // -4.5%

  // пороги для импульса (быстрая дельта)
  const THR = {
    trendBuyUp: 0.0035,   // +0.35%
    revertBuyDn: -0.0035, // -0.35%
    scalperImp:  0.0012,  // ±0.12%
  };

  const log = (lvl: "ok" | "warn" | "err" | "info", s: string) =>
    ctx.onLog(lvl, `[${bot.name}] ${s}`);

  async function place(side: "buy" | "sell", amountSolOrTok: number) {
    const kp = ctx.keypair();
    const dec = clamp(ctx.tokenDecimals() ?? 9, 0, 9);

    // лёгкий разброс размера как у человека
    amountSolOrTok *= 0.9 + Math.random() * 0.2;
    amountSolOrTok = +amountSolOrTok.toFixed(side === "buy" ? 6 : Math.min(6, dec));

    const payload =
      side === "buy"
        ? {
            publicKey: kp.publicKey.toBase58(),
            action: "buy",
            mint: ctx.mint,
            denominatedInSol: "true",
            amount: amountSolOrTok,
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          }
        : {
            publicKey: kp.publicKey.toBase58(),
            action: "sell",
            mint: ctx.mint,
            denominatedInSol: "false",
            amount: amountSolOrTok,
            slippage: (ctx.slippageBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          };

    const vtx = await buildTradeTxPumpPortal(payload);
    vtx.sign([kp]);
    const sig = await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");

    lastFillTs = Date.now();
    bot.fills += 1;
    bot.last = `${side} ${amountSolOrTok}`;
    ctx.onUpdate(bot);
    log("ok", `${side} ${amountSolOrTok} (${sig.slice(0, 8)}…)`);
  }

  /** обновляем позицию после сделки (приближенно по текущей цене) */
  function bookAfterFill(side: "buy" | "sell", sizeSol: number) {
    const p = ctx.price();
    if (!p) return;
    if (side === "buy") {
      const qty = sizeSol / p;
      const newPos = bot.posToken + qty;
      bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + sizeSol) / newPos : p;
      bot.posToken = newPos;
    } else {
      const qty = Math.min(bot.posToken, sizeSol / Math.max(1e-12, p)); // sizeSol тут условно, мы продаём весь pos ниже
      const sellQty = bot.posToken > 0 ? bot.posToken : 0;
      bot.realized += (p - (bot.avgSol || p)) * sellQty;
      bot.posToken = 0;
      bot.avgSol = 0;
    }
    bot.unrealized = bot.posToken * (p - (bot.avgSol || p));
    ctx.onUpdate(bot);
  }

  async function trySellByRisk(): Promise<boolean> {
    if (bot.posToken <= 0 || !bot.avgSol) return false;
    const p = ctx.price();
    if (!p) return false;

    const chg = (p - bot.avgSol) / Math.max(1e-9, bot.avgSol);
    if (chg >= TAKE_PROFIT_BPS / 10_000 || chg <= -STOP_LOSS_BPS / 10_000) {
      if (Date.now() - lastFillTs > baseCooldown) {
        const amountTok = +bot.posToken.toFixed(Math.min(6, ctx.tokenDecimals() ?? 9));
        if (amountTok > 0) {
          await place("sell", amountTok);
          bookAfterFill("sell", amountTok * p);
          return true;
        }
      }
    }
    return false;
  }

  async function loop() {
    if (stopped || !bot.running) return;
    if (pending) { setTimeout(loop, 300); return; }
    pending = true;

    try {
      const p = ctx.price();
      if (!p) { bot.last = "hold"; ctx.onUpdate(bot); return; }

      // Уважаем выключенный AI — вообще не торгуем
      if (!bot.aiEnabled) {
        bot.last = "ai:off";
        ctx.onUpdate(bot);
        return;
      }

      // сперва риск-менеджмент (TP/SL)
      if (await trySellByRisk()) return;

      const impFast = ctx.changeFast(12); // ~12-15 сек импульс
      const ch1m = ctx.change1m();

      const now = Date.now();
      const spendable = Math.max(0, bot.solBalance - minSolLeft);
      const canBuy = spendable > 0.0002 && now - lastFillTs > baseCooldown;

      let wantBuy = false;

      if (bot.strategy === "trend") {
        // в тренде покупаем по ап-импульсу
        wantBuy = impFast > THR.trendBuyUp && canBuy;
      } else if (bot.strategy === "revert") {
        // ловим возврат после мини-просадки
        wantBuy = impFast < THR.revertBuyDn && canBuy;
      } else {
        // scalper — любая микро-волатильность, но соблюдаем cooldown
        wantBuy = Math.abs(impFast) > THR.scalperImp && canBuy;
      }

      if (wantBuy) {
        const budget = Math.max(0.0002, bot.budgetSol || ctx.tradeSize());
        const spend = clamp(Math.min(budget, spendable), 0.0002, 0.5); // верхний хард-лимит на всякий
        await place("buy", spend);
        bookAfterFill("buy", spend);
        return;
      }

      // если ничего делать не хотим — удерживаем
      bot.last = "hold";
      ctx.onUpdate(bot);
    } catch (e: any) {
      bot.lastError = e?.message || String(e);
      ctx.onUpdate(bot);
      log("warn", `tick error: ${bot.lastError}`);
    } finally {
      pending = false;
      if (!stopped) setTimeout(loop, jitter(bot.speedMs || 8000));
    }
  }

  setTimeout(loop, 50);
  return () => { stopped = true; };
}
