// src/live/runner_pump.ts
// Лёгкий раннер под Pump.fun (через /api/trade-local), с фолбэками, бект-off и защитой от гонок.
// Ничего лишнего — только web3.js + confirmSigHttp из твоего utils.

import {
  VersionedTransaction,
  PublicKey,
  Connection,
  Keypair,
  LAMPORTS_PER_SOL,
} from "@solana/web3.js";
import { confirmSigHttp } from "../utils/confirm";

// Типы — совпадают с тем, как ты вызываешь runBot в store.ts
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

// Параметры окружения, которые передаёт store.ts в раннер
export type RunnerCtx = {
  mint: string;
  slippageBps: () => number; // динамический слippage (bps)
  twap?: { slices: number; gapMs: number } | null;
  price: () => number; // текущая цена (SOL)
  change1m: () => number; // относительное изменение за ~1 минуту
  keypair: () => Keypair; // приват ключ бота
  tokenDecimals: () => number; // decimals токена (по факту 6/9)
  tradeSize: () => number; // объём сделки в SOL (если > 0) или из бюджетa
  onLog: (level: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (bot: LiveBot) => void; // аппдейт бота (копия)
};

// —————————————————————————————————————————————————————
//   Вспомогательные утилиты
// —————————————————————————————————————————————————————

/** Точки входа: сначала твой воркер (/x/pump), потом прямая pumpportal.fun. */
const PUMP_BASES: string[] = [
  // если UI запущен с VITE_API_BASE — он подменит fetch на /x/pump сам,
  // но для runner страхуемся ещё раз
  (import.meta as any).env?.VITE_API_BASE
    ? String((import.meta as any).env.VITE_API_BASE).replace(/\/+$/, "") + "/x/pump"
    : "",
  (import.meta as any).env?.VITE_PUMP_API
    ? String((import.meta as any).env.VITE_PUMP_API).replace(/\/+$/, "")
    : "",
  "https://pumpportal.fun",
].filter(Boolean);

/** fetch с фолбэками и таймаутом */
async function fetchPump(path: string, init: RequestInit, retries = 2): Promise<Response> {
  let lastError: any;
  for (const base of PUMP_BASES) {
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let i = 0; i <= retries; i++) {
      try {
        const ctl = new AbortController();
        const t = setTimeout(() => ctl.abort(), 12_000);
        const r = await fetch(url, { ...init, signal: ctl.signal });
        clearTimeout(t);
        if (r.ok) return r;

        // дружелюбная ошибка, чтобы в логах было видно причину
        const txt = await r.text().catch(() => "");
        lastError = new Error(`${r.status} ${r.statusText}: ${txt || url}`);
        break; // переходим к следующей базе
      } catch (e) {
        lastError = e;
        await new Promise((res) => setTimeout(res, 300 + i * 200));
      }
    }
  }
  throw lastError || new Error("All pump endpoints failed");
}

/** Сборка VersionedTransaction через trade-local */
async function buildTradeTxViaLocal(args: {
  publicKey: string;
  action: "buy" | "sell";
  mint: string;
  denominatedInSol: boolean;
  amount: number; // SOL или токенов — в зависимости от denominatedInSol
  slippagePct: number; // проценты (0.5 = 0.5%)
  priorityFee: number; // SOL
  pool?: "auto" | "pump";
}): Promise<VersionedTransaction> {
  const body = {
    publicKey: args.publicKey,
    action: args.action,
    mint: args.mint,
    denominatedInSol: args.denominatedInSol ? "true" : "false",
    amount: Number(args.amount),
    slippage: Number(args.slippagePct),
    priorityFee: Number(args.priorityFee),
    pool: args.pool || "auto",
  };

  const r = await fetchPump("/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(body),
  });

  // upstream мог вернуть JSON-ошибку (наш воркер так делает). Пробуем JSON.
  const ct = r.headers.get("content-type") || "";
  if (ct.includes("application/json")) {
    const j = await r.json().catch(() => ({}));
    // разные провайдеры могут прислать base64 сериализацию
    const b64 = j?.serializedTransaction || j?.tx || j?.transaction;
    if (typeof b64 === "string") {
      const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
      return VersionedTransaction.deserialize(raw);
    }
    // если это наша прокладка «UPSTREAM_4XX»
    if (j?.error || r.status >= 400) {
      throw new Error(
        `trade-local error: ${j?.error || r.status} ${j?.upstreamStatus || ""} ${j?.upstreamText || ""}`.trim()
      );
    }
    // если пришёл «непонятный JSON»
    throw new Error("Unknown trade-local JSON response");
  }

  // нормально: pumpportal чаще шлёт «сырое тело» — это сериализованный VTX
  const raw = new Uint8Array(await r.arrayBuffer());
  // важное место: иногда пользователи видят «message version 111 deserialization…».
  // Это происходит, если прилетела не та сериализация или «битый» ответ.
  // Мы сразу валидируем длину и бросаем человекочитаемую ошибку.
  if (!raw || raw.length < 100) {
    throw new Error("Bad serialized transaction from upstream");
  }
  return VersionedTransaction.deserialize(raw);
}

/** Защита: не даём числам уходить в «бесконечные» знаки после запятой */
const round6 = (n: number) => Math.max(0, +n.toFixed(6));

// —————————————————————————————————————————————————————
//   Логика принятия решений (просто и надёжно)
// —————————————————————————————————————————————————————

function decide(
  bot: LiveBot,
  price: number,
  change1m: number,
  aiEnabled: boolean
): "buy" | "sell" | "hold" {
  const hasPos = bot.posToken > 0.000001;
  const hasSol = bot.solBalance > 0.0005;

  // Если AI выключен — просто твэпим покупку до набора позиции
  if (!aiEnabled) {
    if (!hasPos && hasSol) return "buy";
    if (hasPos && !hasSol) return "sell";
    return "hold";
  }

  // Простейшие пороги (подобраны практикой, а не «красотой»)
  const UP = 0.004; // +0.4%
  const DN = -0.004; // −0.4%

  switch (bot.strategy) {
    case "trend":
      if (change1m > UP && hasSol) return "buy";
      if (change1m < DN && hasPos) return "sell";
      return "hold";
    case "revert":
      if (change1m < DN && hasSol) return "buy";
      if (change1m > UP && hasPos) return "sell";
      return "hold";
    case "scalper":
      // скальпер чаще действует: если есть позиция — частично фиксируем
      if (hasPos && change1m > 0) return "sell";
      if (hasSol && change1m <= 0) return "buy";
      return "hold";
    default:
      return "hold";
  }
}

// —————————————————————————————————————————————————————
//   Основной раннер
// —————————————————————————————————————————————————————

export function runBot(
  connection: Connection,
  botIn: LiveBot,
  ctx: RunnerCtx
): () => void {
  // делаем свою «копию» бота, чтобы править локально и слать onUpdate
  let bot = { ...botIn };
  let stopped = false;
  let busy = false; // защита от гонок/двойных кликов

  const mintPk = new PublicKey(ctx.mint);
  const price = () => Math.max(1e-12, ctx.price());
  const tokenDecimals = () => Math.max(0, ctx.tokenDecimals() || 9);

  async function trade(kind: "buy" | "sell", sizeSol?: number) {
    if (busy || stopped) return;
    busy = true;

    try {
      const kp = ctx.keypair();
      const spendSol =
        kind === "buy"
          ? round6(sizeSol ?? Math.min(bot.budgetSol || 0.01, bot.solBalance))
          : 0;

      // SELL объём берём в токенах (допустим половину позиции для «скальпера»)
      const sellTokens =
        kind === "sell"
          ? round6(
              bot.strategy === "scalper"
                ? bot.posToken * 0.5
                : bot.posToken // для trend/revert — весь объём
            )
          : 0;

      if (kind === "buy" && spendSol <= 0) {
        ctx.onLog("info", `${bot.name}: nothing to buy (SOL=0)`);
        return;
      }
      if (kind === "sell" && sellTokens <= 0) {
        ctx.onLog("info", `${bot.name}: nothing to sell (TOK=0)`);
        return;
      }

      const slipPct = (ctx.slippageBps() || 50) / 100; // bps→%
      const vtx =
        kind === "buy"
          ? await buildTradeTxViaLocal({
              publicKey: kp.publicKey.toBase58(),
              action: "buy",
              mint: mintPk.toBase58(),
              denominatedInSol: true,
              amount: spendSol,
              slippagePct: slipPct,
              priorityFee: 0.00001,
              pool: "auto",
            })
          : await buildTradeTxViaLocal({
              publicKey: kp.publicKey.toBase58(),
              action: "sell",
              mint: mintPk.toBase58(),
              denominatedInSol: false,
              amount: sellTokens,
              slippagePct: slipPct,
              priorityFee: 0.00001,
              pool: "auto",
            });

      // Подписываем локальным ключом и отправляем
      vtx.sign([kp]);
      const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
      await confirmSigHttp(connection, sig);

      // Обновляем состояние «приближённо», чтобы UI не молчал до реальных балансов
      if (kind === "buy") {
        const gotTok = spendSol / price(); // грубо
        const newPos = bot.posToken + gotTok;
        const spent = bot.avgSol * bot.posToken + spendSol;
        bot.avgSol = newPos > 0 ? spent / newPos : 0;
        bot.posToken = newPos;
        bot.solBalance = Math.max(0, bot.solBalance - spendSol - 0.00001);
        bot.last = `buy ${spendSol.toFixed(4)} SOL`;
      } else {
        const outSol = sellTokens * price(); // грубо
        const cost = bot.avgSol * (sellTokens / Math.max(1e-12, bot.posToken));
        bot.realized += outSol - cost;
        bot.posToken = Math.max(0, bot.posToken - sellTokens);
        bot.solBalance += outSol - 0.00001;
        bot.last = `sell ${sellTokens.toFixed(4)} TOK`;
      }

      bot.fills += 1;
      bot.lastError = undefined;
      ctx.onLog("ok", `${bot.name}: ${bot.last} (${sig.slice(0, 8)}…)`);
      ctx.onUpdate({ ...bot });
    } catch (e: any) {
      const msg = e?.message || String(e);
      bot.lastError = msg;
      ctx.onLog("warn", `${bot.name}: trade ${kind} failed: ${msg}`);
      ctx.onUpdate({ ...bot });
    } finally {
      busy = false;
    }
  }

  // Основной цикл
  const loop = async () => {
    if (stopped || !bot.running) return;
    try {
      // Решение на основе простых сигналов
      const ch = ctx.change1m();
      const p = price();

      const decision = decide(bot, p, ch, bot.aiEnabled !== false);
      if (decision === "hold" || bot.manualLock) {
        bot.last = "hold";
        ctx.onUpdate({ ...bot });
        return;
      }

      // размер сделки
      const sz = round6(ctx.tradeSize() || bot.budgetSol || 0.01);

      // TWAP (если включен в настройках store)
      const plan = ctx.twap && ctx.twap.slices >= 2 ? ctx.twap : null;
      if (!plan) {
        await trade(decision, sz);
      } else {
        const portion = round6(sz / plan.slices);
        for (let i = 0; i < plan.slices && !stopped; i++) {
          await trade(decision, portion);
          if (i < plan.slices - 1) {
            await new Promise((res) => setTimeout(res, plan.gapMs));
          }
        }
      }
    } catch (e: any) {
      ctx.onLog("warn", `${bot.name}: runner tick error: ${e?.message || e}`);
    }
  };

  // Стартуем таймер
  const timer = setInterval(loop, Math.max(800, bot.speedMs || 8000));
  // Первый тик — сразу
  loop();

  // Функция остановки
  return function stop() {
    stopped = true;
    try {
      clearInterval(timer);
    } catch {}
  };
}
