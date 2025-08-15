// apps/web/src/store.ts
import "./polyfills";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  sendAndConfirmTransaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  VersionedTransaction,
  Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferInstruction,
} from "@solana/spl-token";
import { fetchExternalPrice } from "./store-price-feeds";
import { getKeypair, createKey, importKey, exportSecret, removeKey } from "./utils/keyring";
import { getMintDecimals, getSPLBalance } from "./utils/solana";

export type BotStrategy = "trend" | "revert" | "scalper";

export type LiveBot = {
  id: string;
  name: string;
  strategy: BotStrategy;
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

type Log = { ts: string; level: "info" | "ok" | "warn" | "err"; msg: string };
const now = () => new Date().toLocaleTimeString();
const b58 = (s: string) => s.match(/[1-9A-HJ-NP-Za-km-z]{32,44}/)?.[0] || null;
const MEMO_PROGRAM_ID = new PublicKey("MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr");

/* ---------------- PumpPortal через твой бекенд ---------------- */
const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const PUMP_BASES = [
  API_BASE ? `${API_BASE}/x/pump` : "",
  ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, ""),
  "https://pumpportal.fun",
].filter(Boolean);

function withTimeout<T>(p: Promise<T>, ms = 10_000): Promise<T> {
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

async function fetchFirstOk(path: string, init: RequestInit, retries = 2) {
  let lastErr: any;
  for (const base of PUMP_BASES) {
    const url = `${base.replace(/\/$/, "")}${path}`;
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const r = await withTimeout(fetch(url, init), 12_000);
        if (r.ok) return r;
        const txt = await r.text().catch(() => "");
        lastErr = new Error(`${r.status} ${r.statusText}: ${txt || url}`);
        break;
      } catch (e) {
        lastErr = e;
        await new Promise((res) => setTimeout(res, 300 + attempt * 300));
      }
    }
  }
  throw lastErr || new Error("All pump endpoints failed");
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

async function buildCreateTxPumpLocal(body: any): Promise<{ tx: VersionedTransaction; mint?: string }> {
  const paths = ["/api/create-token-local", "/api/create-token", "/api/create"];
  let lastErr: any;
  for (const p of paths) {
    try {
      const r = await fetchFirstOk(p, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
      });
      const ct = r.headers.get("content-type") || "";

      if (!ct.includes("application/json")) {
        const raw = new Uint8Array(await r.arrayBuffer());
        return { tx: VersionedTransaction.deserialize(raw) };
      }

      const j = await r.json();
      if (j?.serializedTransaction) {
        const raw = Uint8Array.from(atob(j.serializedTransaction), (c) => c.charCodeAt(0));
        return { tx: VersionedTransaction.deserialize(raw), mint: j.mint || j.token || j.tokenAddress };
      }
      if (j?.mint && j?.tx) {
        const raw = Uint8Array.from(atob(j.tx), (c) => c.charCodeAt(0));
        return { tx: VersionedTransaction.deserialize(raw), mint: j.mint };
      }

      lastErr = new Error("Unknown create-token response format");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Pump create endpoint failed");
}

/* ---------- helper: ensure ATA на кошельке (подписывает Phantom) ---------- */
async function ensureWalletAta(connection: Connection, walletPubkey: string, mint: string) {
  const ph = (window as any).solana;
  const mintPk = new PublicKey(mint);
  const walletPk = new PublicKey(walletPubkey);
  const ata = await getAssociatedTokenAddress(mintPk, walletPk, false);
  const info = await connection.getAccountInfo(ata);
  if (info) return ata;
  const ix = createAssociatedTokenAccountInstruction(walletPk, ata, walletPk, mintPk);
  const { blockhash } = await connection.getLatestBlockhash();
  const tx = new Transaction({ feePayer: walletPk, recentBlockhash: blockhash }).add(ix);
  if (!ph?.signAndSendTransaction) throw new Error("Phantom не поддерживает signAndSendTransaction");
  const { signature } = await ph.signAndSendTransaction(tx);
  await connection.confirmTransaction(signature, "confirmed");
  return ata;
}

/* ---------- helper: безопасная отправка SOL с ретраями/свежим blockhash ---------- */
async function sendTransferWithRetry(
  connection: Connection,
  kp: Keypair,
  toPk: PublicKey,
  lamports: number,
  attempts = 3
): Promise<string> {
  let lastErr: any;
  for (let i = 1; i <= attempts; i++) {
    try {
      const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash("finalized");

      const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: toPk, lamports });
      const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
      tx.sign(kp);

      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      const res = await connection.confirmTransaction({ signature: sig, blockhash, lastValidBlockHeight }, "confirmed");
      const err = (res as any)?.value?.err;
      if (!err) return sig;

      const s = String(err);
      if (s.includes("block height exceeded") || s.includes("expired") || s.includes("Blockhash not found")) {
        lastErr = s;
        await new Promise((r) => setTimeout(r, 250));
        continue;
      }
      throw new Error(s);
    } catch (e: any) {
      const m = e?.message || String(e);
      if (m.includes("block height exceeded") || m.includes("expired") || m.includes("Blockhash not found")) {
        lastErr = m;
        await new Promise((r) => setTimeout(r, 300));
        continue;
      }
      throw e;
    }
  }
  throw new Error(lastErr || "block height exceeded after retries");
}

export type SmartMM = {
  enabled: boolean;
  minBps: number;
  maxBps: number;
  alpha: number;
  twapSec: number;
  twapSlices: number;
};

export type Store = {
  tokenUrl: string;
  tokenMint: string | null;
  price: number;
  candles: { t: number; open: number; high: number; low: number; close: number; volume: number }[];

  external: { provider: "dexscreener" | "jupiter" | "solanatracker" | "pumpportal" | "custom"; endpoint: string; apiKey?: string };

  log: Log[];
  addLog: (l: Log["level"], m: string) => void;

  bots: LiveBot[];
  slippageBps: number;

  useRandomSize: boolean;
  tradeRange: { minSol: number; maxSol: number };
  getTradeSize: () => number;

  smartMM: SmartMM;
  getSmartBps: () => number;
  getTwapPlan: () => { slices: number; gapMs: number } | null;

  treasuryKeyId?: string;
  autoTopUp: boolean;
  minFeeSol: number;
  topUpToSol: number;
  setTreasuryFromSecret: (name: string, secret: string) => void;
  topUpBot: (connection: any, botId: string) => Promise<void>;

  drainMinKeepSol: number;
  drainDelayMs: number;
  drainBotTo: (connection: any, botId: string, destAddress: string) => Promise<void>;
  drainAllTo: (connection: any, destAddress: string) => Promise<void>;

  warmupCfg: { simulatePerBot: number; gapMs: number; ensureATA: boolean };
  safeWarmupBots: (connection: any) => Promise<void>;

  mainnetWarmupCfg: { txPerBot: number; lamports: number; gapMs: number; maxTotalSolPerBot: number };
  mainnetWarmupTransfers: (connection: any, opts?: Partial<Store["mainnetWarmupCfg"]>) => Promise<void>;

  setTokenUrl: (u: string) => void;

  addBot: (name?: string) => void;
  importBotFromSecret: (name: string, secretB64: string) => void;
  updateBot: (id: string, patch: Partial<LiveBot>) => void;
  removeBot: (id: string) => void;
  exportBotKey: (id: string) => string | null;

  startBot: (id: string, connection: any) => Promise<void>;
  stopBot: (id: string) => void;
  startAll: (connection: any) => void;
  stopAll: () => void;

  refreshBalances: (connection: any) => Promise<void>;
  tickReal: () => Promise<void>;

  // Pump
  createPumpToken: (
    connection: Connection,
    creatorPubkey: string,
    params: {
      name: string;
      symbol: string;
      image: string;
      description?: string;
      website?: string;
      twitter?: string;
      decimals?: number;
      initialBuySol?: number;
    }
  ) => Promise<void>;
  buyAllBotsOnPump: (connection: Connection, opts?: { keepFeeSol?: number }) => Promise<void>;
  sellAllToWalletOnPump: (connection: Connection, walletPubkey: string, opts?: { keepFeeSol?: number }) => Promise<void>;

  autoMode: boolean;
  autoCfg: { slopeLookback: number; volLookback: number; slopeThr: number; volThr: number };
  autoTick: () => void;

  _mintDecimals?: number;
  _lastTopUp?: Record<string, number>;
  _ppSub?: any;
};

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      tokenUrl: "",
      tokenMint: null,
      price: 0,
      candles: [],

      external: { provider: "dexscreener", endpoint: "https://api.dexscreener.com" },

      log: [],
      addLog: (level, msg) => set((s) => ({ log: [...s.log, { ts: now(), level, msg }].slice(-600) })),

      bots: [],
      slippageBps: 50,

      useRandomSize: true,
      tradeRange: { minSol: 0.005, maxSol: 0.03 },
      getTradeSize() {
        const { useRandomSize, tradeRange } = get();
        if (!useRandomSize) return 0;
        const min = Math.max(0, Number(tradeRange.minSol) || 0);
        const max = Math.max(min, Number(tradeRange.maxSol) || min);
        const val = min + Math.random() * (max - min);
        return Math.max(0.000001, +val.toFixed(6));
      },

      smartMM: { enabled: true, minBps: 20, maxBps: 200, alpha: 0.6, twapSec: 120, twapSlices: 4 },

      getSmartBps() {
        const s = get();
        if (!s.smartMM.enabled) return s.slippageBps;
        const cs = s.candles;
        if (cs.length < 6) return Math.round((s.smartMM.minBps + s.smartMM.maxBps) / 2);

        const last = cs.slice(-5);
        const p0 = last[0].close;
        const p1 = last[last.length - 1].close;
        const slope = (p1 - p0) / Math.max(1e-9, p0);
        const mean = last.reduce((a, c) => a + c.close, 0) / last.length;
        const sd =
          Math.sqrt(last.reduce((a, c) => a + (c.close - mean) ** 2, 0) / last.length) / Math.max(1e-9, mean);
        const sNorm = Math.min(1, Math.abs(slope) / 0.02);
        const vNorm = Math.min(1, sd / 0.01);

        const w = s.smartMM.alpha;
        const score = w * sNorm + (1 - w) * vNorm;
        const bps = s.smartMM.minBps + score * (s.smartMM.maxBps - s.smartMM.minBps);
        return Math.round(bps);
      },

      getTwapPlan() {
        const mm = get().smartMM;
        if (!mm.enabled || mm.twapSlices < 2 || mm.twapSec <= 0) return null;
        const gapMs = Math.floor((mm.twapSec * 1000) / mm.twapSlices);
        return { slices: mm.twapSlices, gapMs };
      },

      // Treasury / авто-пополнение
      treasuryKeyId: undefined,
      autoTopUp: true,
      minFeeSol: 0.01,
      topUpToSol: 0.03,
      setTreasuryFromSecret: (name, secret) => {
        const rec = importKey(name || "Treasury", secret);
        set({ treasuryKeyId: rec.id });
        get().addLog("ok", `Treasury задан: ${rec.pubkey}`);
      },

      // Drain
      drainMinKeepSol: 0.01,
      drainDelayMs: 30_000,

      _ppSub: undefined as any,
      setTokenUrl: (u) => {
        const mint = b58(u);
        const isPump = /pump\.fun/i.test(u);
        set({ tokenUrl: u, tokenMint: mint, _mintDecimals: undefined });
        if (mint && isPump) {
          import("./external/pumpportal").then(({ attachPumpPortalFeed }) => {
            const s = get();
            try {
              s._ppSub?.detach?.();
            } catch {}
            const sub = attachPumpPortalFeed({
              mint,
              onPrice: (p) => set({ price: p }),
              onCandle: (m, p) =>
                set((st) => {
                  const last = st.candles.at(-1);
                  let c = st.candles.slice();
                  if (!last || last.t !== m) c.push({ t: m, open: p, high: p, low: p, close: p, volume: 0 });
                  else {
                    last.high = Math.max(last.high, p);
                    last.low = Math.min(last.low, p);
                    last.close = p;
                  }
                  if (c.length > 1000) c = c.slice(-1000);
                  return { candles: c };
                }),
              onMigration: () => get().addLog("info", "Token migrated from bonding curve → Raydium"),
            });
            set((s2) => ({ ...s2, external: { ...s2.external, provider: "pumpportal" }, _ppSub: sub }));
          });
        } else {
          try {
            get()._ppSub?.detach?.();
          } catch {}
          set({ _ppSub: undefined });
        }
      },

      addBot: (name) => {
        const rec = createKey(name || `Bot#${get().bots.length + 1}`);
        const bot: LiveBot = {
          id: rec.id,
          name: rec.name,
          pubkey: rec.pubkey,
          keyId: rec.id,
          strategy: "trend",
          budgetSol: 0.02,
          speedMs: 8000,
          running: false,
          aiEnabled: true,
          manualLock: false,
          solBalance: 0,
          tokenBalance: 0,
          posToken: 0,
          avgSol: 0,
          realized: 0,
          unrealized: 0,
          fills: 0,
        };
        set((s) => ({ bots: [...s.bots, bot] }));
        get().addLog("ok", `Создан суб-кошелёк ${bot.name}: ${bot.pubkey}`);
      },

      importBotFromSecret: (name, secretB64) => {
        const rec = importKey(name || `BotImported#${get().bots.length + 1}`, secretB64);
        const bot: LiveBot = {
          id: rec.id,
          name: rec.name,
          pubkey: rec.pubkey,
          keyId: rec.id,
          strategy: "trend",
          budgetSol: 0.02,
          speedMs: 8000,
          running: false,
          aiEnabled: true,
          manualLock: false,
          solBalance: 0,
          tokenBalance: 0,
          posToken: 0,
          avgSol: 0,
          realized: 0,
          unrealized: 0,
          fills: 0,
        };
        set((s) => ({ bots: [...s.bots, bot] }));
        get().addLog("ok", `Импортирован ключ для ${bot.name}: ${bot.pubkey}`);
      },

      updateBot: (id, patch) => set((s) => ({ bots: s.bots.map((b) => (b.id === id ? { ...b, ...patch } : b)) })),
      removeBot: (id) => {
        removeKey(id);
        set((s) => ({ bots: s.bots.filter((b) => b.id !== id) }));
      },
      exportBotKey: (id) => exportSecret(id),

      // Пополнение из Treasury
      async topUpBot(connection, botId) {
        const s = get();
        const bot = s.bots.find((b) => b.id === botId);
        if (!bot) return;
        const kpId = s.treasuryKeyId;
        if (!kpId) {
          s.addLog("warn", "Не задан Treasury — пополнение невозможно");
          return;
        }
        const kp = getKeypair(kpId);
        const need = Math.max(0, s.topUpToSol - bot.solBalance);
        if (need <= 0) return;
        try {
          const ix = SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: new PublicKey(bot.pubkey),
            lamports: Math.ceil(need * LAMPORTS_PER_SOL),
          });
          const tx = new Transaction().add(ix);
          const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
          s.addLog("ok", `Top-up для ${bot.name}: +${need.toFixed(6)} SOL (${sig})`);
        } catch (e: any) {
          s.addLog("err", `Top-up error: ${e?.message || String(e)}`);
        }
      },

      // Drain
      async drainBotTo(connection, botId, destAddress) {
        const s = get();
        const bot = s.bots.find((b) => b.id === botId);
        if (!bot) return;
        const dest = new PublicKey(destAddress);

        const keep = Math.max(s.drainMinKeepSol, s.minFeeSol);
        let sendSol = bot.solBalance - keep - 0.00001;
        if (sendSol <= 0) {
          s.addLog("info", `Drain ${bot.name}: нечего отправлять (баланс ${bot.solBalance.toFixed(6)} SOL)`);
          return;
        }
        sendSol = Math.max(0, +sendSol.toFixed(6));
        const lamports = Math.floor(sendSol * LAMPORTS_PER_SOL);
        if (lamports <= 0) {
          s.addLog("info", `Drain ${bot.name}: слишком мало для перевода`);
          return;
        }

        try {
          const kp = getKeypair(bot.keyId);
          const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports });
          const tx = new Transaction().add(ix);
          const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
          s.addLog(
            "ok",
            `Drain ${bot.name} → ${dest.toBase58().slice(0, 4)}…: ${sendSol.toFixed(6)} SOL (${sig})`
          );
        } catch (e: any) {
          s.addLog("err", `Drain error ${bot.name}: ${e?.message || String(e)}`);
        }
      },

      async drainAllTo(connection, destAddress) {
        const bots = get().bots;
        const delay = get().drainDelayMs;
        for (let i = 0; i < bots.length; i++) {
          await get().drainBotTo(connection, bots[i].id, destAddress);
          if (i < bots.length - 1) await new Promise((r) => setTimeout(r, delay));
        }
        await get().refreshBalances(connection);
      },

      // SAFE warm-up симуляции
      warmupCfg: { simulatePerBot: 5, gapMs: 2000, ensureATA: true },

      async safeWarmupBots(connection) {
        const s = get();
        if (!s.tokenMint) {
          s.addLog("warn", "Warm-up: mint не задан");
          return;
        }
        const mintPk = new PublicKey(s.tokenMint);

        for (const bot of s.bots) {
          if (bot.solBalance < s.minFeeSol) {
            if (s.autoTopUp && s.treasuryKeyId) {
              try {
                await get().topUpBot(connection, bot.id);
              } catch {}
              await get().refreshBalances(connection);
            } else {
              s.addLog("warn", `Warm-up: пропуск ${bot.name} — мало SOL и нет авто-доната`);
              continue;
            }
          }

          if (get().warmupCfg.ensureATA) {
            try {
              const owner = new PublicKey(bot.pubkey);
              const ata = await getAssociatedTokenAddress(mintPk, owner, false);
              const info = await connection.getAccountInfo(ata);
              if (!info) {
                const kp = getKeypair(bot.keyId);
                const ix = createAssociatedTokenAccountInstruction(kp.publicKey, ata, owner, mintPk);
                const tx = new Transaction().add(ix);
                const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
                s.addLog("ok", `Warm-up: создан ATA для ${bot.name}: ${ata.toBase58()} (${sig})`);
              }
            } catch (e: any) {
              s.addLog("err", `Warm-up ATA ${bot.name}: ${e?.message || e}`);
            }
          }

          try {
            const kp = getKeypair(bot.keyId);
            for (let i = 0; i < get().warmupCfg.simulatePerBot; i++) {
              const memoIx = new TransactionInstruction({
                keys: [],
                programId: MEMO_PROGRAM_ID,
                data: Buffer.from(`warmup:${Date.now()}:${i}`),
              });
              const tx = new Transaction().add(memoIx);
              tx.feePayer = kp.publicKey;
              tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
              tx.sign(kp);
              await connection.simulateTransaction(tx, { sigVerify: false });
              await new Promise((r) => setTimeout(r, get().warmupCfg.gapMs));
            }
            s.addLog("ok", `Warm-up: симуляции выполнены для ${bot.name}`);
          } catch (e: any) {
            s.addLog("warn", `Warm-up simulate ${bot.name}: ${e?.message || e}`);
          }
        }

        await get().refreshBalances(connection);
      },

      // MAINNET warm-up
      mainnetWarmupCfg: { txPerBot: 30, lamports: 5_000, gapMs: 1200, maxTotalSolPerBot: 0.005 },

      async mainnetWarmupTransfers(connection, opts = {}) {
        const s = get();
        const ep = (connection as any)?.rpcEndpoint || "";
        if (/devnet|testnet/i.test(ep)) {
          s.addLog("warn", "Mainnet warm-up доступен только на mainnet RPC");
          return;
        }

        const bots = s.bots;
        if (bots.length < 2) {
          s.addLog("warn", "Нужно ≥2 бота для кольцевых переводов");
          return;
        }

        const cfg = { ...s.mainnetWarmupCfg, ...opts };
        const { txPerBot, lamports, gapMs, maxTotalSolPerBot } = cfg;

        const feeLamports = 5_000;
        const estPerTx = lamports + feeLamports;
        const estPerBotLam = txPerBot * estPerTx;
        const estPerBotSol = estPerBotLam / LAMPORTS_PER_SOL;

        if (estPerBotSol > maxTotalSolPerBot) {
          s.addLog(
            "warn",
            `Warm-up остановлен: расчётная трата ${estPerBotSol.toFixed(6)} SOL/бот > лимита ${maxTotalSolPerBot}`
          );
          return;
        }

        for (const b of bots) {
          if (b.solBalance < estPerBotSol + s.minFeeSol) {
            s.addLog(
              "warn",
              `Warm-up: у ${b.name} мало SOL (${b.solBalance.toFixed(6)}), требуется ≥ ${(
                estPerBotSol + s.minFeeSol
              ).toFixed(6)} SOL`
            );
          }
        }

        s.addLog(
          "info",
          `Mainnet warm-up: ${txPerBot} tx/бот, ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL/tx, лимит ~${estPerBotSol.toFixed(6)} SOL/бот`
        );

        for (const sender of bots) {
          const kp = getKeypair(sender.keyId);
          if (!kp) {
            s.addLog("err", `Нет ключа для ${sender.name}`);
            continue;
          }

          const idx = bots.findIndex((x) => x.id === sender.id);
          const receiver = bots[(idx + 1) % bots.length];
          const toPk = new PublicKey(receiver.pubkey);

          for (let i = 0; i < txPerBot; i++) {
            try {
              const sig = await sendTransferWithRetry(connection as Connection, kp, toPk, lamports, 3);
              s.addLog(
                "ok",
                `Warm-up ${sender.name} → ${receiver.name}: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${
                  i + 1
                }/${txPerBot}) ${sig.slice(0, 8)}…`
              );
            } catch (e: any) {
              s.addLog("warn", `Warm-up tx fail ${sender.name}: ${e?.message || e}`);
            }
            await new Promise((r) => setTimeout(r, Math.max(900, gapMs)));
          }
        }

        await get().refreshBalances(connection);
        s.addLog("ok", `Mainnet warm-up завершён: ${txPerBot} tx/бот (≈${estPerBotSol.toFixed(6)} SOL/бот)`);
      },

      // Запуск/остановка
      async startBot(id, connection) {
        const s = get();
        const bot = s.bots.find((b) => b.id === id);
        if (!bot || !s.tokenMint) return;

        if (bot.solBalance < s.minFeeSol) {
          if (s.autoTopUp && s.treasuryKeyId) {
            await get().topUpBot(connection, bot.id);
            await get().refreshBalances(connection);
          } else {
            s.addLog(
              "warn",
              `Бот ${bot.name} НЕ запущен: мало SOL (есть ${bot.solBalance.toFixed(6)}, нужно ≥ ${s.minFeeSol})`
            );
            return;
          }
        }

        const kp = getKeypair(bot.keyId);
        if (!kp) return s.addLog("err", "Не найден ключ бота");

        bot.running = true;
        set({ bots: [...s.bots] });

        const runnerLoader =
          get().external.provider === "pumpportal"
            ? () => import("./live/runner_pump").then((m) => m.runBot)
            : () => import("./live/runner").then((m) => m.runBot);
        const run = await runnerLoader();
        const stop = run(connection, bot, {
          mint: s.tokenMint!,
          slippageBps: () => get().getSmartBps(),
          twap: get().getTwapPlan(),
          price: () => get().price,
          change1m: () => {
            const cs = get().candles;
            if (cs.length < 2) return 0;
            const a = cs[cs.length - 2].close;
            const b = cs[cs.length - 1].close;
            return (b - a) / Math.max(1e-9, a);
          },
          keypair: () => kp as Keypair,
          tokenDecimals: () => get()._mintDecimals ?? 9,
          tradeSize: () => {
            const r = get().getTradeSize();
            return r > 0 ? r : bot.budgetSol;
          },
          onLog: (lvl, msg) => get().addLog(lvl, msg),
          onUpdate: (b) => set((st) => ({ bots: st.bots.map((x) => (x.id === b.id ? { ...b } : x)) })),
        });
        (bot as any).__stop = stop;
      },

      stopBot: (id) =>
        set((s) => {
          const b = s.bots.find((x) => x.id === id);
          if (b && (b as any).__stop) {
            try {
              (b as any).__stop();
            } catch {}
            delete (b as any).__stop;
          }
          if (b) b.running = false;
          return { bots: [...s.bots] };
        }),

      startAll: (connection) => {
        get().bots.forEach((b) => get().startBot(b.id, connection));
      },
      stopAll: () => {
        get().bots.forEach((b) => get().stopBot(b.id));
      },

      // Балансы + авто-донат
      async refreshBalances(connection) {
        const mint = get().tokenMint;
        if (!mint) return;

        let dec = get()._mintDecimals;
        if (dec == null) {
          try {
            dec = await getMintDecimals(connection, mint);
            set({ _mintDecimals: dec });
          } catch {}
        }
        const decimals = dec ?? 9;

        const bots = await Promise.all(
          get().bots.map(async (b) => {
            try {
              const lam = await connection.getBalance(new PublicKey(b.pubkey));
              const sol = lam / LAMPORTS_PER_SOL;
              const raw = await getSPLBalance(connection, b.pubkey, mint);
              const tok = Number(raw) / Math.pow(10, decimals);
              return { ...b, solBalance: sol, tokenBalance: tok };
            } catch {
              return b;
            }
          })
        );
        set({ bots });

        const { autoTopUp, minFeeSol, topUpBot } = get();
        if (autoTopUp) {
          const nowTs = Date.now();
          const last = get()._lastTopUp || {};
          for (const b of bots) {
            if (b.solBalance < minFeeSol) {
              if (!last[b.id] || nowTs - last[b.id] > 30_000) {
                last[b.id] = nowTs;
                try {
                  await topUpBot(connection, b.id);
                } catch {}
              }
            }
          }
          set({ _lastTopUp: last });
        }
      },

      // Прайс/свечи
      async tickReal() {
        const s = get();
        if (!s.tokenMint) return;
        if (s.external.provider === "pumpportal") return; // pump.fun обновляет цену через WS
        const p = await fetchExternalPrice(s.external, s.tokenMint);
        if (!p) return;
        set((st) => {
          const t = Date.now();
          const m = Math.floor(t / 60000) * 60000;
          const last = st.candles.at(-1);
          let c = st.candles.slice();
          if (!last || last.t !== m) c.push({ t: m, open: p, high: p, low: p, close: p, volume: 0 });
          else {
            last.high = Math.max(last.high, p);
            last.low = Math.min(last.low, p);
            last.close = p;
          }
          if (c.length > 1000) c = c.slice(-1000);

          const bots = st.bots.map((b) => ({ ...b, unrealized: b.posToken * (p - (b.avgSol || p)) }));
          return { price: p, candles: c, bots };
        });
      },

      // Pump: создать токен и автопокупка
      async createPumpToken(connection, creatorPubkey, params) {
        try {
          const body = {
            publicKey: creatorPubkey,
            name: params.name,
            symbol: params.symbol,
            image: params.image,
            description: params.description || "",
            twitter: params.twitter || "",
            website: params.website || "",
            decimals: params.decimals ?? 6,
            createMetadata: true,
            initialBuySol: params.initialBuySol || 0,
          };
          const { tx, mint } = await buildCreateTxPumpLocal(body);

          const ph = (window as any).solana;
          if (!ph?.signAndSendTransaction) {
            throw new Error("Phantom должен поддерживать signAndSendTransaction (vtx)");
          }
          const { signature } = await ph.signAndSendTransaction(tx);
          await connection.confirmTransaction(signature, "confirmed");

          const tokenMint = mint || get().tokenMint;
          if (tokenMint) {
            get().addLog("ok", `Token created: ${tokenMint} (${signature.slice(0, 8)}…)`);
            set((s) => ({
              ...s,
              tokenUrl: tokenMint,
              tokenMint: tokenMint,
              external: { ...s.external, provider: "pumpportal" },
            }));
          } else {
            get().addLog("warn", "Token created, но API не вернул mint — укажи адрес вручную");
          }

          await get().buyAllBotsOnPump(connection, { keepFeeSol: Math.max(0.002, get().minFeeSol) });
          await get().refreshBalances(connection);
        } catch (e: any) {
          get().addLog("err", `Create token failed: ${e?.message || String(e)}`);
        }
      },

      async buyAllBotsOnPump(connection, opts = {}) {
        const keep = Math.max(0.0005, (opts as any).keepFeeSol ?? get().minFeeSol);
        const s = get();
        if (!s.tokenMint) {
          s.addLog("warn", "Auto-buy: mint не задан");
          return;
        }
        for (let i = 0; i < s.bots.length; i++) {
          const b = s.bots[i];
          const spend = Math.max(0, +(b.solBalance - keep).toFixed(6));
          if (spend <= 0) {
            s.addLog("info", `Auto-buy ${b.name}: нечего тратить`);
            continue;
          }
          try {
            const kp = getKeypair(b.keyId);
            const vtx = await buildTradeTxPumpLocal({
              publicKey: kp.publicKey.toBase58(),
              action: "buy",
              mint: s.tokenMint,
              denominatedInSol: "true",
              amount: spend,
              slippage: (get().getSmartBps() || 50) / 100, // bps -> %
              priorityFee: 0.00001,
              pool: "auto",
            });
            vtx.sign([kp]);
            const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
            await connection.confirmTransaction(sig, "confirmed");
            s.addLog("ok", `Auto-buy ${b.name}: ${spend.toFixed(6)} SOL (${sig.slice(0, 8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `Auto-buy ${s.bots[i].name}: ${e?.message || String(e)}`);
          }
          if (i < s.bots.length - 1) await new Promise((r) => setTimeout(r, 1200));
        }
      },

      // Sell ALL — боты → кошелёк → одна продажа
      async sellAllToWalletOnPump(connection, walletPubkey, _opts = {}) {
        const s = get();
        if (!s.tokenMint) {
          s.addLog("warn", "Sell ALL: mint не задан");
          return;
        }

        const mintPk = new PublicKey(s.tokenMint);
        const walletPk = new PublicKey(walletPubkey);

        let decimals = s._mintDecimals;
        if (decimals == null) {
          try {
            decimals = await getMintDecimals(connection, s.tokenMint);
            set({ _mintDecimals: decimals });
          } catch {}
        }
        decimals = decimals ?? 9;

        try {
          await ensureWalletAta(connection as Connection, walletPubkey, s.tokenMint);
        } catch (e) {
          s.addLog("warn", `Ensure wallet ATA: ${String((e as any)?.message || e)}`);
        }

        for (let i = 0; i < s.bots.length; i++) {
          const b = s.bots[i];
          try {
            const kp = getKeypair(b.keyId);

            const srcAta = await getAssociatedTokenAddress(mintPk, kp.publicKey, false);
            const dstAta = await getAssociatedTokenAddress(mintPk, walletPk, false);

            const raw = await getSPLBalance(connection, b.pubkey, s.tokenMint);
            const amountRaw = BigInt(raw as any);
            if (amountRaw <= 0n) {
              s.addLog("info", `Sell ALL: у ${b.name} токенов нет`);
              continue;
            }

            const tx = new Transaction();

            const dstInfo = await connection.getAccountInfo(dstAta);
            if (!dstInfo) {
              tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, dstAta, walletPk, mintPk));
            }

            tx.add(createTransferInstruction(srcAta, dstAta, kp.publicKey, amountRaw));

            const sig = await sendAndConfirmTransaction(connection, tx, [kp]);
            s.addLog(
              "ok",
              `Sell ALL: ${b.name} → wallet ${Number(amountRaw) / Math.pow(10, decimals)} TOK (${sig.slice(0, 8)}…)`
            );
          } catch (e: any) {
            s.addLog("warn", `Sell ALL transfer ${s.bots[i].name}: ${e?.message || String(e)}`);
          }
          if (i < s.bots.length - 1) await new Promise((r) => setTimeout(r, 1200));
        }

        try {
          const rawWallet = await getSPLBalance(connection, walletPubkey, s.tokenMint);
          const amountTok = Number(rawWallet as any) / Math.pow(10, decimals);

          if (amountTok <= 0) {
            s.addLog("info", "Sell ALL: на кошельке нет токенов для продажи");
            return;
          }

          const amountRounded = +amountTok.toFixed(Math.min(6, decimals));

          const vtx = await buildTradeTxPumpLocal({
            publicKey: walletPubkey,
            action: "sell",
            mint: s.tokenMint,
            denominatedInSol: "false",
            amount: amountRounded,
            slippage: (get().getSmartBps() || 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          });

          const ph = (window as any).solana;
          if (!ph?.signAndSendTransaction) throw new Error("Phantom не поддерживает signAndSendTransaction");
          const { signature } = await ph.signAndSendTransaction(vtx);
          await connection.confirmTransaction(signature, "confirmed");
          s.addLog("ok", `Sell ALL: кошелёк продал ~${amountRounded} TOK (${signature.slice(0, 8)}…)`);
        } catch (e: any) {
          s.addLog("err", `Sell ALL sell-phase: ${e?.message || String(e)}`);
        }

        await get().refreshBalances(connection);
      },

      // Авто-профили AI
      autoMode: false,
      autoCfg: { slopeLookback: 20, volLookback: 20, slopeThr: 0.002, volThr: 0.004 },
      autoTick() {
        const s = get();
        if (!s.autoMode) return;
        const cs = s.candles;
        if (cs.length < 25) return;

        const { slopeLookback, volLookback, slopeThr, volThr } = s.autoCfg;
        const lastN = cs.slice(-Math.max(slopeLookback, volLookback));
        const prices = lastN.map((c) => c.close);
        const p0 = prices[0];
        const p1 = prices[prices.length - 1];
        if (!p0) return;

        const slope = (p1 - p0) / p0;
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const sd =
          Math.sqrt(prices.reduce((a, b) => a + (b - mean) * (b - mean), 0) / prices.length) /
          Math.max(1e-9, mean);

        const trending = Math.abs(slope) > slopeThr;
        const noisy = sd > volThr;

        let desired: Array<{ type: "trend" | "revert" | "scalper"; share: number }>;
        if (trending) {
          desired = noisy
            ? [
                { type: "trend", share: 0.6 },
                { type: "scalper", share: 0.25 },
                { type: "revert", share: 0.15 },
              ]
            : [
                { type: "trend", share: 0.7 },
                { type: "revert", share: 0.2 },
                { type: "scalper", share: 0.1 },
              ];
        } else {
          desired = noisy
            ? [
                { type: "revert", share: 0.55 },
                { type: "trend", share: 0.3 },
                { type: "scalper", share: 0.15 },
              ]
            : [
                { type: "revert", share: 0.6 },
                { type: "trend", share: 0.3 },
                { type: "scalper", share: 0.1 },
              ];
        }

        const bots = [...s.bots];
        const free = bots.filter((b) => !b.manualLock);
        if (free.length === 0) return;

        const total = free.length;
        const counts = desired.map((x) => ({ type: x.type, n: Math.round(x.share * total) }));
        let sum = counts.reduce((a, c) => a + c.n, 0);
        while (sum < total) {
          counts[0].n++;
          sum++;
        }
        while (sum > total) {
          counts[0].n--;
          sum--;
        }

        const profiles = {
          trend: (i: number) => ({ strategy: "trend" as const, speedMs: 5000 + ((i % 3) * 2000), budgetSol: 0.02 + ((i % 2) * 0.01) }),
          revert: (i: number) => ({ strategy: "revert" as const, speedMs: 9000 + ((i % 3) * 3000), budgetSol: 0.015 }),
          scalper: (i: number) => ({ strategy: "scalper" as const, speedMs: 1500 + ((i % 3) * 500), budgetSol: 0.008 }),
        };

        let idx = 0;
        const newBots = bots.map((b) => {
          if (b.manualLock) return b;
          let bucket: "trend" | "revert" | "scalper" = "trend";
          for (const c of counts) {
            if (c.n > 0) {
              bucket = c.type as any;
              c.n--;
              break;
            }
          }
          const prof = profiles[bucket](idx++);
          return { ...b, ...prof };
        });

        set({ bots: newBots });
      },
    }),
    {
      name: "meme-bundler:v1",
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tokenUrl: s.tokenUrl,
        tokenMint: s.tokenMint,
        bots: s.bots,
        slippageBps: s.slippageBps,
        useRandomSize: s.useRandomSize,
        tradeRange: s.tradeRange,
        smartMM: s.smartMM,
        autoTopUp: s.autoTopUp,
        minFeeSol: s.minFeeSol,
        topUpToSol: s.topUpToSol,
        drainMinKeepSol: s.drainMinKeepSol,
        drainDelayMs: s.drainDelayMs,
        treasuryKeyId: s.treasuryKeyId,
      }),
      onRehydrateStorage: () => (state) => {
        try {
          const u = state?.tokenUrl;
          if (u) setTimeout(() => get().setTokenUrl(u), 0);
        } catch {}
      },
    }
  )
);
