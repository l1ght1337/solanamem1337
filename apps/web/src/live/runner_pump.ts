// apps/web/src/live/runner_pump.ts
import {
  Connection,
  VersionedTransaction,
  Keypair,
} from "@solana/web3.js";

/** ======= minimal fetch helpers (с фолбэком на воркер / прямой pump.fun) ======= */
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const PUMP_BASES = [
  API_BASE ? `${API_BASE}/x/pump` : "",
  ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, ""),
  "https://pumpportal.fun",
].filter(Boolean);

function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error("fetch timeout")), ms);
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

async function fetchFirstOk(path: string, init: RequestInit, retries = 1) {
  let lastErr: any;
  for (const base of PUMP_BASES) {
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let a = 0; a <= retries; a++) {
      try {
        const r = await withTimeout(fetch(url, init), 12000);
        if (r.ok) return r;
        const txt = await r.text().catch(() => "");
        lastErr = new Error(`${r.status} ${r.statusText}: ${txt || url}`);
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 300 + a * 250));
      }
    }
  }
  throw lastErr || new Error("All pump endpoints failed");
}

async function buildTradeVtx(body: {
  publicKey: string;
  action: "buy" | "sell";
  mint: string;
  denominatedInSol: "true" | "false";
  amount: number;
  slippage: number; // percent (например 0.5)
  priorityFee: number;
  pool: "auto" | "pump";
}): Promise<VersionedTransaction> {
  const res = await fetchFirstOk("/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });

  // Если апстрим отдал JSON-ошибку — бросаем понятную ошибку
  const ct = res.headers.get("content-type") || "";
  if (!res.ok && ct.includes("application/json")) {
    const j = await res.json().catch(() => ({}));
    throw new Error(j?.error || j?.message || "trade-local upstream error");
  }

  // pump.fun обычно отдаёт сырой бинарник VTX
  const raw = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(raw);
}

/** ======= простая логика принятия решений ======= */

type LogFn = (lvl: "info" | "ok" | "warn" | "err", msg: string) => void;

// подбираем долю продажи/покупки по стратегии и движению цены
function decideAction(params: {
  strategy: "trend" | "revert" | "scalper";
  change1m: number; // относительное изменение за минуту
  hasPosition: boolean;
}):
  | { type: "buy"; weight: number }   // weight в диапазоне 0..1 — доля от tradeSize()/position
  | { type: "sell"; weight: number }
  | { type: "hold" } {
  const { strategy, change1m, hasPosition } = params;

  // базовые триггеры
  const up = change1m > 0.004;     // +0.4% за минуту
  const down = change1m < -0.004;  // -0.4% за минуту

  if (strategy === "trend") {
    if (up) return { type: "buy", weight: 1 };
    if (down && hasPosition) return { type: "sell", weight: 0.5 };
    return { type: "hold" };
  }

  if (strategy === "revert") {
    if (down) return { type: "buy", weight: 1 };
    if (up && hasPosition) return { type: "sell", weight: 0.4 };
    return { type: "hold" };
  }

  // scalper — мелкие сделки чаще
  if (strategy === "scalper") {
    if (Math.abs(change1m) < 0.002) {
      return Math.random() < 0.6 ? { type: "buy", weight: 0.6 } : { type: "hold" };
    }
    if (up) return { type: "sell", weight: 0.5 };
    if (down) return { type: "buy", weight: 0.7 };
    return { type: "hold" };
  }

  return { type: "hold" };
}

// простая TP/SL логика: возвращает sell вес (0..1) или null
function tpSlDecision(params: {
  avgSol: number;
  price: number;
  hasPosition: boolean;
}): number | null {
  const { avgSol, price, hasPosition } = params;
  if (!hasPosition || !avgSol || !price) return null;

  const pnl = (price - avgSol) / Math.max(1e-9, avgSol);

  // TP 4% — продать половину, 8% — продать 80%
  if (pnl > 0.08) return 0.8;
  if (pnl > 0.04) return 0.5;

  // SL 4% — продать 40%
  if (pnl < -0.04) return 0.4;

  return null;
}

/** ======= основной раннер ======= */
export function runBot(
  connection: Connection,
  bot: any, // тип упрощён, чтобы не тащить циклические импорты
  ctx: {
    mint: string;
    slippageBps: () => number;
    twap?: { slices: number; gapMs: number } | null;
    price: () => number;
    change1m: () => number;
    keypair: () => Keypair;
    tokenDecimals: () => number;
    tradeSize: () => number; // желаемый размер сделки в SOL (для buy) или базовый объём для sell
    onLog: LogFn;
    onUpdate: (b: any) => void;
  }
) {
  let stopped = false;
  const kp = ctx.keypair();

  const log = (lvl: "info" | "ok" | "warn" | "err", msg: string) =>
    ctx.onLog(lvl, `${bot.name}: ${msg}`);

  async function tradeOnce() {
    if (stopped) return;

    try {
      const price = ctx.price();
      const ch1 = ctx.change1m();

      // TP/SL имеет приоритет
      const tpsl = tpSlDecision({
        avgSol: Number(bot.avgSol || 0),
        price,
        hasPosition: (bot.tokenBalance || 0) > 0,
      });

      let decision:
        | { type: "buy"; weight: number }
        | { type: "sell"; weight: number }
        | { type: "hold" } = { type: "hold" };

      if (tpsl != null) {
        decision = { type: "sell", weight: tpsl };
      } else {
        decision = decideAction({
          strategy: bot.strategy as "trend" | "revert" | "scalper",
          change1m: ch1,
          hasPosition: (bot.tokenBalance || 0) > 0,
        });
      }

      if (decision.type === "hold") {
        bot.last = "hold";
        ctx.onUpdate({ ...bot });
        return;
      }

      // параметры сделки
      const slipPct = Math.max(0, (ctx.slippageBps() || 50) / 100); // bps -> %
      const priorityFee = 0.00001;

      if (decision.type === "buy") {
        // потратить часть от tradeSize, но не больше доступного SOL - небольшой резерв
        const base = Math.max(0, ctx.tradeSize());
        const spend = Math.max(
          0,
          Math.min(base * decision.weight, Math.max(0, (bot.solBalance || 0) - 0.001))
        );

        if (spend <= 0) {
          bot.last = "hold";
          ctx.onUpdate({ ...bot });
          return;
        }

        const vtx = await buildTradeVtx({
          publicKey: kp.publicKey.toBase58(),
          action: "buy",
          mint: ctx.mint,
          denominatedInSol: "true",
          amount: +spend.toFixed(6),
          slippage: slipPct,
          priorityFee,
          pool: "auto",
        });

        vtx.sign([kp]);
        const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
        await connection.confirmTransaction(sig, "confirmed");

        bot.fills = (bot.fills || 0) + 1;
        bot.last = `buy ${spend.toFixed(4)} SOL`;
        ctx.onUpdate({ ...bot });
        log("ok", `buy ${spend.toFixed(6)} SOL (${sig.slice(0, 8)}…)`);
        return;
      }

      if (decision.type === "sell") {
        // продаём долю от текущего количества токенов
        const posTok = Number(bot.tokenBalance || 0);
        if (posTok <= 0) {
          bot.last = "hold";
          ctx.onUpdate({ ...bot });
          return;
        }

        const sellTok = Math.max(0, +(posTok * decision.weight).toFixed(6));
        if (sellTok <= 0) {
          bot.last = "hold";
          ctx.onUpdate({ ...bot });
          return;
        }

        const vtx = await buildTradeVtx({
          publicKey: kp.publicKey.toBase58(),
          action: "sell",
          mint: ctx.mint,
          denominatedInSol: "false",
          amount: sellTok, // в токенах
          slippage: slipPct,
          priorityFee,
          pool: "auto",
        });

        vtx.sign([kp]);
        const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
        await connection.confirmTransaction(sig, "confirmed");

        bot.fills = (bot.fills || 0) + 1;
        bot.last = `sell ~${sellTok} TOK`;
        ctx.onUpdate({ ...bot });
        log("ok", `sell ~${sellTok} TOK (${sig.slice(0, 8)}…)`);
        return;
      }
    } catch (e: any) {
      const msg = e?.message || String(e);
      bot.lastError = msg;
      ctx.onUpdate({ ...bot });
      log("warn", `trade error: ${msg}`);
    }
  }

  // основной цикл
  let timer: any;
  const loop = async () => {
    if (stopped) return;
    await tradeOnce();
    if (stopped) return;
    timer = setTimeout(loop, Math.max(500, Number(bot.speedMs) || 5000));
  };

  // стратуем
  loop();

  // возвращаем остановщик
  return () => {
    stopped = true;
    try { clearTimeout(timer); } catch {}
  };
}
