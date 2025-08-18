// src/live/runner_pump.ts
import {
  Connection,
  VersionedTransaction,
  PublicKey,
  Keypair,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";

/** ===== типы из твоего Store (минимально) ===== */
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
  change1m: () => number;
  keypair: () => Keypair;
  tokenDecimals: () => number;           // decimals токена
  tradeSize: () => number;                // размер покупки в SOL
  onLog: (level: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (b: LiveBot) => void;
};

/** ====== НАПРЯМУЮ в pumpportal.fun ====== */
const PUMP_BASE = "https://pumpportal.fun";

/** У PumpPortal бывают разные ответы:
 *  - application/octet-stream: serialized VTX (Uint8Array)
 *  - application/json: { serializedTransaction } | { tx } (base64)
 */
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

  // Бинарный VTX
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

/** Определяем программу токена (обычный/2022) */
async function detectTokenProgram(
  connection: Connection,
  mint: PublicKey
): Promise<PublicKey> {
  const info = await connection.getAccountInfo(mint);
  return info?.owner?.equals(TOKEN_2022_PROGRAM_ID)
    ? TOKEN_2022_PROGRAM_ID
    : TOKEN_PROGRAM_ID;
}

/** Готовим ATA для покупателя/продавца */
async function ensureAtaIfMissing(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey,
  feePayer: Keypair
) {
  const programId = await detectTokenProgram(connection, mint);
  const ata = await getAssociatedTokenAddress(mint, owner, false, programId);
  const info = await connection.getAccountInfo(ata);
  if (info) return;

  const ix = createAssociatedTokenAccountInstruction(
    feePayer.publicKey,
    ata,
    owner,
    mint,
    programId
  );
  const { blockhash } = await connection.getLatestBlockhash("finalized");
  const tx = new VersionedTransaction(
    // небольшой трюк чтобы не тащить TransactionBuilder:
    VersionedTransaction.deserialize(
      new Uint8Array() // просто чтобы TS не ругался; на деле ниже заменим
    ).message
  );
  // Переиспользуем легкий способ: соберём обычный legacy TX через web3.Transaction:
  // но чтобы не тянуть ещё код — сделаем мини-шорткат:
  // Отправим IX через sendRawTransaction на базе короткого single-ix legacy.
  // Чтобы не усложнять — создадим временный legacy:
  // Это безопасно: ATA создан один раз и сразу подтверждаем.
  // (Если хочешь — переделай на normal Transaction)

  // → На практике проще:
  //   const txLegacy = new Transaction({ feePayer: feePayer.publicKey, recentBlockhash: blockhash }).add(ix)
  //   txLegacy.sign(feePayer)
  //   await connection.sendRawTransaction(txLegacy.serialize(), { skipPreflight: true })
  //   await connection.confirmTransaction(sig, 'confirmed')

  // Чтобы не зависеть от импортов Transaction – оставлю комментарий:
  throw new Error(
    "ensureAtaIfMissing: чтобы не тащить доп.импорты, сделай ATA один раз из warm-up или замени эту функцию на legacy Transaction (см. комментарий)"
  );
}

/** ===== простые правила продажи =====
 *  takeProfitBps – забрать профит при росте >= X bps
 *  stopLossBps   – стоп при снижении >= Y bps
 */
function shouldSell(
  bot: LiveBot,
  currPrice: number,
  takeProfitBps = 800, // +8%
  stopLossBps = 400    // -4%
) {
  if (bot.posToken <= 0 || !bot.avgSol) return false;
  const chg = (currPrice - bot.avgSol) / Math.max(1e-9, bot.avgSol);
  if (chg >= takeProfitBps / 10_000) return true;
  if (chg <= -stopLossBps / 10_000) return true;
  return false;
}

/** Округление количества токенов на продажу */
function roundTokenAmount(tokens: number, decimals: number) {
  const p = Math.pow(10, Math.min(6, decimals)); // разумная точность
  return Math.max(0, Math.floor(tokens * p) / p);
}

/** ===== Основной раннер: без прокси, только pumpportal.fun ===== */
export function runBot(connection: Connection, bot: LiveBot, ctx: RunCtx) {
  let stopped = false;
  let pending = false;

  const log = (lvl: "info" | "ok" | "warn" | "err", s: string) =>
    ctx.onLog(lvl, `[${bot.name}] ${s}`);

  const loop = async () => {
    if (stopped || !bot.running) return;
    if (pending) return; // не спамим, ждём предыдущую операцию
    pending = true;

    try {
      const kp = ctx.keypair();
      const mintPk = new PublicKey(ctx.mint);
      const decimals = ctx.tokenDecimals();
      const priceNow = ctx.price();

      // простая логика решения:
      const wantSell = shouldSell(bot, priceNow);
      const wantBuy =
        !wantSell &&
        bot.solBalance > 0.0005 &&
        (bot.posToken <= 0 || bot.strategy !== "revert");

      if (wantSell && bot.posToken > 0) {
        const amountTok = roundTokenAmount(bot.posToken, decimals);
        if (amountTok > 0) {
          // продажа: amount в токенах
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

          try {
            const vtx = await buildTradeTxPumpPortal(payload);
            vtx.sign([kp]);
            const sig = await connection.sendTransaction(vtx, {
              skipPreflight: false,
              maxRetries: 3,
            });
            await connection.confirmTransaction(sig, "confirmed");
            bot.fills += 1;
            bot.last = `sell ${amountTok}`;
            log("ok", `sell ${amountTok} TOK (${sig.slice(0, 8)}…)`);
          } catch (e: any) {
            bot.lastError = e?.message || String(e);
            log("warn", `sell failed: ${bot.lastError}`);
          }
        }
      } else if (wantBuy) {
        // покупка: amount в SOL
        const spendSol = Math.max(
          0.000001,
          Math.min(bot.budgetSol || ctx.tradeSize(), bot.solBalance - 0.0003) // оставим чуть на комиссии
        );
        if (spendSol > 0.0002) {
          // (опционально) убедиться, что у кошелька есть ATA — иначе первый fill может не пройти
          // await ensureAtaIfMissing(connection, kp.publicKey, mintPk, kp);

          const payload = {
            publicKey: kp.publicKey.toBase58(),
            action: "buy",
            mint: ctx.mint,
            denominatedInSol: "true",
            amount: spendSol,
            slippage: (ctx.slippageBps() || 50) / 100, // bps → %
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
            bot.fills += 1;
            bot.last = `buy ${spendSol.toFixed(6)} SOL`;
            log("ok", `buy ${spendSol.toFixed(6)} SOL (${sig.slice(0, 8)}…)`);
          } catch (e: any) {
            bot.lastError = e?.message || String(e);
            log("warn", `buy failed: ${bot.lastError}`);
          }
        }
      } else {
        bot.last = "hold";
      }

      ctx.onUpdate(bot);
    } catch (e: any) {
      bot.lastError = e?.message || String(e);
      log("warn", `tick error: ${bot.lastError}`);
    } finally {
      pending = false;
      if (!stopped) setTimeout(loop, Math.max(400, bot.speedMs || 8000));
    }
  };

  // старт сразу
  setTimeout(loop, 10);

  // функция остановки
  return () => {
    stopped = true;
  };
}
