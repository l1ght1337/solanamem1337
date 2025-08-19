// apps/web/src/live/runner_pump.ts
import {
  Connection,
  VersionedTransaction,
  PublicKey,
  Keypair,
} from "@solana/web3.js";

/** ===== типы из Store (минимально) ===== */
type LiveBot = {
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
  changeFast?: (sec?: number) => number; // быстрый импульс 10–15 сек
  change1m: () => number;                 // запасной, минутный

  keypair: () => Keypair;
  tokenDecimals: () => number;
  tradeSize: () => number;
  onLog: (level: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
};

/** ====== pumpportal.fun ====== */
const PUMP_BASE = "https://pumpportal.fun";

/** API: возвращает VTX */
async function buildTradeTxPumpPortal(
  payload: Record<string, any>
): Promise<VersionedTransaction> {
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
  const b64 =
    j?.serializedTransaction || j?.tx || j?.transaction || j?.vtx || null;
  if (!b64) throw new Error("pumpportal: no transaction in response");

  const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
  return VersionedTransaction.deserialize(raw);
}

/** округление токенов на продажу */
function roundTok(tokens: number, decimals: number) {
  const p = Math.pow(10, Math.min(6, decimals));
  return Math.max(0, Math.floor(tokens * p) / p);
}

/** трейлинг/TP/SL в bps (1 bps = 0.01%) */
const TP_SCALPER_BPS = 120;  // ~1.2%
const TP_TREND_BPS   = 250;  // ~2.5%
const TP_REVERT_BPS  = 160;  // ~1.6%
const SL_ALL_BPS     = 180;  // ~1.8% защитный стоп

/** быстрые пороги импульса (на основе changeFast за ~15 сек) */
const FBUY_SCALPER = 0.0010;  // +0.10%
const FSELL_SCALPER = -0.0006; // -0.06%
const FBUY_TREND = 0.0008;    // +0.08%
const FSELL_TREND = -0.0012;  // -0.12%
const FBUY_REVERT = -0.0010;  // для revert — покупаем на провале  -0.10%
const FEXIT_REVERT = 0.0007;  // фиксируем на откате +0.07%

/** небольшой хелпер */
const sleep = (ms: number) => new Promise(res => setTimeout(res, ms));

/** обновление позиции (приблизительно, чтобы UI жил) */
function applyPositionOnBuy(bot: LiveBot, price: number, spendSol: number) {
  const qty = spendSol / Math.max(1e-9, price);
  const newPos = bot.posToken + qty;
  bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + spendSol) / newPos : price;
  bot.posToken = newPos;
}

function applyPositionOnSell(bot: LiveBot, price: number, sellTok: number) {
  const sellQty = Math.min(bot.posToken, sellTok);
  bot.posToken = Math.max(0, bot.posToken - sellQty);
  bot.realized += (price - (bot.avgSol || price)) * sellQty;
  if (bot.posToken === 0) bot.avgSol = 0;
}

/** решаем, что делать, используя “человеческие” правила */
function decideHuman(
  bot: LiveBot,
  price: number,
  changeFast: number,
  change1m: number
): { side: "buy" | "sell" | "hold"; portion?: number } {
  const pos = bot.posToken;

  // случайный "скип" действия (как будто подумал/передумал)
  if (Math.random() < 0.05) return { side: "hold" };

  // защитный стоп/профит
  if (pos > 0 && bot.avgSol > 0) {
    const chg = (price - bot.avgSol) / bot.avgSol;
    const tp = (bot.strategy === "scalper" ? TP_SCALPER_BPS :
               bot.strategy === "trend"   ? TP_TREND_BPS   : TP_REVERT_BPS) / 10_000;
    if (chg >= tp)       return { side: "sell", portion: 0.4 + Math.random()*0.4 }; // частично
    if (chg <= -SL_ALL_BPS / 10_000) return { side: "sell", portion: 0.6 + Math.random()*0.4 };
  }

  if (bot.strategy === "scalper") {
    if (changeFast > FBUY_SCALPER) return { side: "buy" };
    if (pos > 0 && (changeFast < FSELL_SCALPER)) return { side: "sell", portion: 0.35 + Math.random()*0.35 };
    return { side: "hold" };
  }

  if (bot.strategy === "trend") {
    // тренд: берём по ускорению (fast) или по минутной свече
    if (changeFast > FBUY_TREND || change1m > 0.0035) return { side: "buy" };
    if (pos > 0 && (changeFast < FSELL_TREND)) return { side: "sell", portion: 0.25 + Math.random()*0.35 };
    return { side: "hold" };
  }

  // revert: покупаем на падении и фиксируем часть на отскоке
  if (bot.strategy === "revert") {
    if (changeFast < FBUY_REVERT) return { side: "buy" };
    if (pos > 0 && changeFast > FEXIT_REVERT) return { side: "sell", portion: 0.4 + Math.random()*0.4 };
    return { side: "hold" };
  }

  return { side: "hold" };
}

export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;
  let lastTradeTs = 0;
  let lastSide: "buy" | "sell" | "hold" = "hold";

  const log = (lvl: "info" | "ok" | "warn" | "err", s: string) =>
    ctx.onLog(lvl, `[${bot.name}] ${s}`);

  async function sendBuy(spendSol: number) {
    const kp = ctx.keypair();
    const payload = {
      publicKey: kp.publicKey.toBase58(),
      action: "buy",
      mint: ctx.mint,
      denominatedInSol: "true",
      amount: spendSol,
      slippage: (ctx.slippageBps() || 50) / 100,
      priorityFee: 0.00001,
      pool: "auto",
    };
    const vtx = await buildTradeTxPumpPortal(payload);
    vtx.sign([kp]);
    const sig = await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    return sig as string;
  }

  async function sendSell(amountTok: number) {
    const kp = ctx.keypair();
    const payload = {
      publicKey: kp.publicKey.toBase58(),
      action: "sell",
      mint: ctx.mint,
      denominatedInSol: "false",
      amount: amountTok,
      slippage: (ctx.slippageBps() || 50) / 100,
      priorityFee: 0.00001,
      pool: "auto",
    };
    const vtx = await buildTradeTxPumpPortal(payload);
    vtx.sign([kp]);
    const sig = await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
    await connection.confirmTransaction(sig, "confirmed");
    return sig as string;
  }

  const loop = async () => {
    if (stopped || !bot.running) return;
    if (pending) return;
    pending = true;

    try {
      const priceNow = ctx.price();
      if (!priceNow || !bot.aiEnabled) {
        bot.last = bot.aiEnabled ? "no price" : "ai:off";
        ctx.onUpdate(bot);
        return;
      }

      // кулдаун, чтобы не «строчить»
      const cooldown = Math.max(800, bot.speedMs * (1.0 + Math.random() * 0.4));
      if (Date.now() - lastTradeTs < cooldown) {
        bot.last = "cooldown";
        ctx.onUpdate(bot);
        return;
      }

      const fast = typeof ctx.changeFast === "function" ? ctx.changeFast(15) : 0;
      const slow = ctx.change1m();

      const decision = decideHuman(bot, priceNow, fast, slow);
      if (decision.side === "hold") {
        bot.last = "hold";
        ctx.onUpdate(bot);
        return;
      }

      if (decision.side === "buy" && bot.solBalance > 0.0006) {
        // размер — с небольшим разбросом и учётом комиссий
        const base = Math.max(0.0002, Math.min(bot.budgetSol || ctx.tradeSize(), bot.solBalance - 0.00035));
        const spendSol = +(base * (0.9 + Math.random() * 0.2)).toFixed(6);
        if (spendSol <= 0.0002) { bot.last = "hold"; ctx.onUpdate(bot); return; }

        // микро-TWAP: делим на 2–5 частей, если нужно
        const needTwap = ctx.twap && spendSol > 2 * (spendSol / 4);
        const slices = needTwap ? Math.max(2, Math.min(5, (ctx.twap?.slices || 3))) : 1;
        const gap = needTwap ? Math.max(600, (ctx.twap?.gapMs || 1200)) : 0;

        const chunk = spendSol / slices;
        for (let i = 0; i < slices; i++) {
          try {
            const sig = await sendBuy(+chunk.toFixed(6));
            applyPositionOnBuy(bot, priceNow, +chunk.toFixed(6));
            bot.fills += 1;
            bot.last = `buy ${chunk.toFixed(4)} SOL`;
            lastTradeTs = Date.now();
            lastSide = "buy";
            log("ok", `BUY ${chunk.toFixed(6)} (${sig.slice(0, 8)}…)`);
            ctx.onUpdate(bot);
          } catch (e: any) {
            bot.lastError = e?.message || String(e);
            bot.last = "buy failed";
            log("warn", `buy failed: ${bot.lastError}`);
            ctx.onUpdate(bot);
            break; // прерываем twap
          }
          if (needTwap && i < slices - 1) {
            const jitter = Math.floor((Math.random() * 2 - 1) * 300);
            await sleep(Math.max(400, gap + jitter));
          }
        }
      }

      if (decision.side === "sell" && bot.posToken > 0) {
        const portion = Math.min(1, Math.max(0.1, decision.portion ?? 0.5));
        const dec = ctx.tokenDecimals();
        const amountTok = roundTok(bot.posToken * portion, dec);
        if (amountTok > 0) {
          try {
            const sig = await sendSell(amountTok);
            applyPositionOnSell(bot, priceNow, amountTok);
            bot.fills += 1;
            bot.last = `sell ${amountTok}`;
            lastTradeTs = Date.now();
            lastSide = "sell";
            log("ok", `SELL ${amountTok} (${sig.slice(0, 8)}…)`);
            ctx.onUpdate(bot);
          } catch (e: any) {
            bot.lastError = e?.message || String(e);
            bot.last = "sell failed";
            log("warn", `sell failed: ${bot.lastError}`);
            ctx.onUpdate(bot);
          }
        }
      }
    } catch (e: any) {
      bot.lastError = e?.message || String(e);
      log("warn", `tick error: ${bot.lastError}`);
    } finally {
      pending = false;
      // лёгкая вариативность таймера — чтобы «не тикали в такт»
      const jitter = Math.floor((Math.random() * 2 - 1) * 250);
      if (!stopped) setTimeout(loop, Math.max(400, (bot.speedMs || 8000) + jitter));
    }
  };

  setTimeout(loop, 10);
  return () => { stopped = true; };
}
