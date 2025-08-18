// apps/web/src/live/runner_pump.ts
import { VersionedTransaction, PublicKey, Connection } from "@solana/web3.js";
import { confirmSigHttp } from "../utils/confirm";

/** ============= минимальные настройки, можно подкрутить ============= */
const CFG = {
  // вход
  minBuySol: 0.002,                 // меньше – не покупаем (пылинка)
  coolDownMs: 7000,                 // пауза между сделками
  // выход
  takeProfitBps: 900,               // +9% — первая частичная фиксация
  takeProfit2Bps: 1800,             // +18% — вторая частичная фиксация
  trailBps: 350,                    // трейлинг от пика 3.5% (продажа всех)
  stopLossBps: 800,                 // -8% от средней — стоп
  scale1: 0.35,                     // сколько продать на TP1
  scale2: 0.35,                     // сколько продать на TP2
  minHoldMs: 25_000,                // минимум держим позицию (чтобы не «пилиться»)
  priorityFee: 0.00001,             // SOL
};
/** =================================================================== */

/** те же базисы, что и в store.ts */
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const PUMP_BASES = [
  API_BASE ? `${API_BASE}/x/pump` : "",
  ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, ""),
  "https://pumpportal.fun",
].filter(Boolean);

function withTimeout<T>(p: Promise<T>, ms = 12_000) {
  return new Promise<T>((res, rej) => {
    const t = setTimeout(() => rej(new Error("fetch timeout")), ms);
    p.then(v => (clearTimeout(t), res(v)), e => (clearTimeout(t), rej(e)));
  });
}

async function fetchFirstOk(path: string, init: RequestInit, retries = 1) {
  let lastErr: any;
  for (const base of PUMP_BASES) {
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let i = 0; i <= retries; i++) {
      try {
        const r = await withTimeout(fetch(url, init));
        if (r.ok) return r;
        lastErr = new Error(`${r.status} ${r.statusText}`);
        break;
      } catch (e) { lastErr = e; await new Promise(r => setTimeout(r, 300)); }
    }
  }
  throw lastErr || new Error("pump endpoints failed");
}

async function buildTradeTxPumpLocal(body: any): Promise<VersionedTransaction> {
  const res = await fetchFirstOk("/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  const raw = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(raw);
}

type Bot = {
  id: string; name: string; pubkey: string; keyId: string;
  strategy: "trend" | "revert" | "scalper";
  budgetSol: number; speedMs: number; aiEnabled: boolean;
  posToken: number; avgSol: number; last?: string;
};

type Cfg = {
  mint: string;
  slippageBps: () => number;
  price: () => number;
  change1m: () => number;                  // твоя функция из store (разница цены за 1м)
  tokenDecimals: () => number;
  tradeSize: () => number;                 // если включён random-size — даст рандом, иначе budget
  keypair: () => any;                      // Keypair бота
  onLog: (lvl: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: Partial<Bot> & { id: string }) => void;
};

/** главный цикл: вернёт stop-функцию */
export function runBot(connection: Connection, bot: Bot, cfg: Cfg) {
  let stopped = false;

  // состояние позиции (в раннере, чтобы продавать даже если store ещё не успел обновить)
  let posTok = bot.posToken || 0;
  let avgSol = bot.avgSol || 0;
  let peak = 0;                 // локальный максимум цены после входа
  let lastTrade = 0;

  const dec = cfg.tokenDecimals() ?? 9;
  const mint = new PublicKey(cfg.mint);
  const minTok = 1 / Math.pow(10, dec); // «пылинка» токена

  const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));
  const now = () => Date.now();

  async function buy(spendSol: number) {
    if (spendSol < CFG.minBuySol) return false;
    try {
      const kp = cfg.keypair();
      const vtx = await buildTradeTxPumpLocal({
        publicKey: kp.publicKey.toBase58(),
        action: "buy",
        mint: mint.toBase58(),
        denominatedInSol: "true",
        amount: +spendSol.toFixed(6),
        slippage: (cfg.slippageBps() || 50) / 100,
        priorityFee: CFG.priorityFee,
        pool: "auto",
      });
      vtx.sign([kp]);
      const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
      await confirmSigHttp(connection, sig);

      const p = cfg.price();
      // приблизим полученное кол-во (точный баланс подтянет refreshBalances)
      const gotTok = Math.max(minTok, spendSol / Math.max(1e-12, p));
      const newTok = posTok + gotTok;
      avgSol = (avgSol * posTok + spendSol) / newTok;
      posTok = newTok;
      peak = Math.max(peak, p);
      lastTrade = now();

      cfg.onUpdate({ id: bot.id, posToken: posTok, avgSol, last: `buy ${spendSol.toFixed(4)} SOL` });
      cfg.onLog("ok", `${bot.name}: BUY ${spendSol.toFixed(6)} SOL (${sig.slice(0,8)}…)`);
      return true;
    } catch (e: any) {
      cfg.onLog("warn", `${bot.name}: buy fail: ${e?.message || e}`);
      return false;
    }
  }

  async function sell(qTok: number, label: string) {
    if (qTok <= minTok) return false;
    try {
      const kp = cfg.keypair();
      // amount — в токенах, denominatedInSol: "false"
      const vtx = await buildTradeTxPumpLocal({
        publicKey: kp.publicKey.toBase58(),
        action: "sell",
        mint: mint.toBase58(),
        denominatedInSol: "false",
        amount: +qTok.toFixed(Math.min(6, dec)),
        slippage: (cfg.slippageBps() || 50) / 100,
        priorityFee: CFG.priorityFee,
        pool: "auto",
      });
      vtx.sign([kp]);
      const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
      await confirmSigHttp(connection, sig);

      posTok = Math.max(0, posTok - qTok);
      if (posTok <= minTok) { posTok = 0; avgSol = 0; peak = 0; }
      lastTrade = now();

      cfg.onUpdate({ id: bot.id, posToken: posTok, avgSol, last: label });
      cfg.onLog("ok", `${bot.name}: SELL ${qTok.toFixed(6)} TOK (${label}) ${sig.slice(0,8)}…`);
      return true;
    } catch (e: any) {
      cfg.onLog("warn", `${bot.name}: sell fail: ${e?.message || e}`);
      return false;
    }
  }

  function wantBuy(): boolean {
    if (!bot.aiEnabled) return true; // режим без AI — всегда пытаемся по стратегии

    const ch1m = cfg.change1m(); // ~моментум минуты
    const price = cfg.price();

    if (bot.strategy === "trend")   return ch1m > 0;       // растём — подхватываем
    if (bot.strategy === "revert")  return ch1m < 0;       // ловим откаты
    if (bot.strategy === "scalper") return Math.abs(ch1m) > 0.002; // волатильность
    return true;
  }

  function sellSignals() {
    if (posTok <= minTok || avgSol <= 0) return { should: false };

    const p = cfg.price();
    const pnl = (p - avgSol) / avgSol;          // относительная PnL
    peak = Math.max(peak || p, p);
    const drawdown = (peak - p) / Math.max(1e-12, peak);

    const age = now() - lastTrade;

    // трейлинг от пика
    if (drawdown * 10_000 >= CFG.trailBps && age >= CFG.minHoldMs) {
      return { should: true, kind: "TRAIL", qty: posTok }; // всё
    }
    // стоп-лосс
    if (pnl * 10_000 <= -CFG.stopLossBps && age >= CFG.minHoldMs) {
      return { should: true, kind: "SL", qty: posTok };    // всё
    }
    // частичные TP
    if (pnl * 10_000 >= CFG.takeProfit2Bps) {
      return { should: true, kind: "TP2", qty: posTok * CFG.scale2 };
    }
    if (pnl * 10_000 >= CFG.takeProfitBps) {
      return { should: true, kind: "TP1", qty: posTok * CFG.scale1 };
    }
    return { should: false as const };
  }

  async function tick() {
    const price = cfg.price();
    if (!price || isNaN(price)) return;

    // ЕСЛИ позиция есть — проверяем выходы
    const s = sellSignals();
    if (s.should) {
      const q = Math.max(minTok, Math.min(posTok, s.qty || posTok));
      await sell(q, s.kind!);
      return;
    }

    // Иначе — подумать о входе
    const spent = Math.max(CFG.minBuySol, Math.min(bot.budgetSol, cfg.tradeSize()));
    const canTrade = now() - lastTrade >= CFG.coolDownMs;

    if (canTrade && wantBuy()) {
      await buy(spent);
    } else {
      // просто обновим «last» чтобы видеть статус
      const label =
        posTok > 0
          ? `hold PnL ${( (price-avgSol)/Math.max(1e-12,avgSol) * 100 ).toFixed(2)}%`
          : `idle`;
      cfg.onUpdate({ id: bot.id, last: label });
    }
  }

  (async () => {
    while (!stopped) {
      try { await tick(); } catch {}
      await sleep(Math.max(600, bot.speedMs || 2000));
    }
  })();

  return () => { stopped = true; };
}
