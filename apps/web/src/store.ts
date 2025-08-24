// apps/web/src/store.ts
import "./polyfills";
import { confirmSigHttp } from "./utils/confirm";
import { create } from "zustand";
import { persist, createJSONStorage } from "zustand/middleware";
import {
  PublicKey,
  Keypair,
  SystemProgram,
  Transaction,
  LAMPORTS_PER_SOL,
  TransactionInstruction,
  VersionedTransaction,
  Connection,
} from "@solana/web3.js";
import {
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
  createTransferCheckedInstruction,
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchExternalPrice } from "./store-price-feeds";
import { getKeypair, createKey, importKey, exportSecret, removeKey } from "./utils/keyring";
import { getMintDecimals, getSPLBalance } from "./utils/solana";
import { scheduleFetch, getNetMetrics } from "./utils/network";

export type BotStrategy = "trend" | "revert" | "scalper" | "momentum" | "range" | "maker";

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

/* ---------------- PumpPortal через твои прокси/бекенд ---------------- */
const RAW_PROXIES = (import.meta.env as any).VITE_PUMP_PROXIES || "";
const PROXIES: string[] = RAW_PROXIES
  .split(",")
  .map((s: string) => s.trim().replace(/\/+$/, ""))
  .filter(Boolean);

const API_BASE = ((import.meta.env as any).VITE_API_BASE || "").replace(/\/+$/, "");
const ALT_PUMP = ((import.meta.env as any).VITE_PUMP_API || "").replace(/\/+$/, "");

// ⬇️ Jupiter base (через твой воркер). По умолчанию — "/jup"
const JUP_BASE = ((import.meta.env as any).VITE_JUP_BASE || "/jup").replace(/\/+$/, "");

// финальный список апстримов (прокси → свой бекенд → alt → публичный)
const PUMP_BASES: string[] = [
  ...PROXIES.map((p) => `${p}/x/pump`),
  API_BASE ? `${API_BASE}/x/pump` : "",
  ALT_PUMP,
  "https://pumpportal.fun",
].filter(Boolean);

// «липкий» индекс базы — успешная база будет приоритетной
let stickyBaseIdx = -1;

/** Усиленная обёртка: пробует все базы с приоритетом sticky, повторы на 429/5xx, таймауты */
async function fetchFirstOk(path: string, init: RequestInit = {}, retriesPerBase = 1) {
  const order = [...PUMP_BASES.keys()];
  if (stickyBaseIdx >= 0) {
    const i = order.indexOf(stickyBaseIdx);
    if (i > 0) { order.splice(i, 1); order.unshift(stickyBaseIdx); }
  }

  const baseInit: RequestInit = {
    keepalive: false, // меньше висящих соединений
    credentials: "omit",
    cache: "no-store",
    mode: "cors",
    ...init,
    headers: { "Cache-Control": "no-store", ...(init.headers || {}) },
  };

  let lastErr: any;
  for (const idx of order) {
    const base = PUMP_BASES[idx];
    const url = `${base.replace(/\/$/, "")}${path}`;

    for (let attempt = 0; attempt <= Math.max(0, retriesPerBase); attempt++) {
      const backoff = attempt === 0 ? 0 : 300 * attempt + Math.floor(Math.random() * 250);
      if (backoff) await new Promise((res) => setTimeout(res, backoff));
      try {
        // планировщик ограничивает глобальную конкуренцию и rps
        const r = await scheduleFetch(url, { ...(baseInit as any), timeoutMs: 15_000, tries: 1 }, "pump");

        if (r.ok) { stickyBaseIdx = idx; return r; }

        if (r.status === 429 || r.status >= 500) {
          lastErr = new Error(`${r.status} ${r.statusText}`);
          continue;
        } else {
          stickyBaseIdx = idx;
          return r;
        }
      } catch (e) {
        lastErr = e;
      }
    }
  }
  stickyBaseIdx = -1;
  throw lastErr || new Error("All pump endpoints failed");
}

/* ⬇️ helper для Jupiter: уходит на {proxy}/jup/... или {proxy}/x/pump/jup/... */
export function jupFetch(path: string, init?: RequestInit, retriesPerBase = 1) {
  const p = path.startsWith("/") ? path : `/${path}`;
  return fetchFirstOk(`${JUP_BASE}${p}`, init, retriesPerBase);
}

/* ⛑ ГЛОБАЛЬНЫЙ АНТИ-CORS ПАТЧ ДЛЯ JUPITER
   Любой прямой fetch на https://quote-api.jup.ag/* или https://price.jup.ag/*
   автоматически уходит через наш прокси (JUP_BASE) и много-прокси обёртку. */
(() => {
  const origFetch = globalThis.fetch?.bind(globalThis);
  if (!origFetch) return;
  const JUP_FORCE_PROXY = String(((import.meta as any).env?.VITE_JUP_FORCE_PROXY ?? '0')).trim() === '1';
  if (!JUP_FORCE_PROXY) return; // по умолчанию не перехватываем: используем прямой CORS у Jupiter
  const needsProxy = (u: string) =>
    /^https:\/\/(quote-api|price)\.jup\.ag\//.test(u);
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (typeof url === "string" && needsProxy(url)) {
      try {
        const u = new URL(url);
        // Превращаем https://quote-api.jup.ag/v6/quote?... -> {base}/jup/v6/quote?...
        return fetchFirstOk(`${JUP_BASE}${u.pathname}${u.search}`, init, 1);
      } catch {
        // если вдруг не распарсили — падаем обратно на обычный fetch
      }
    }
    return origFetch(input as any, init);
  }) as any;
})();
/* ---------- /анти-CORS ---------- */

/* ---------- Local API ---------- */
async function buildTradeTxPumpLocal(body: any): Promise<VersionedTransaction> {
  try {
    const res = await fetchFirstOk("/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }, 2);
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("application/json")) {
      const j = await res.json();
      const b64 = j?.serializedTransaction ?? j?.tx ?? j?.transaction ?? j?.vtx;
      if (!b64) throw new Error("trade-local: no serializedTransaction");
      const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
      return VersionedTransaction.deserialize(raw);
    }
    const raw = new Uint8Array(await res.arrayBuffer());
    return VersionedTransaction.deserialize(raw);
  } catch (_e) {
    const res = await fetchFirstOk("/api/trade", {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify(body),
    }, 2);
    const j = await res.json().catch(() => ({} as any));
    const b64 = j?.serializedTransaction ?? j?.tx ?? j?.transaction ?? j?.vtx;
    if (!b64) throw new Error("trade fallback: no serializedTransaction");
    const raw = Uint8Array.from(atob(String(b64)), (c) => c.charCodeAt(0));
    return VersionedTransaction.deserialize(raw);
  }
}

async function buildCreateTxPumpLocal(body: any): Promise<{ tx: VersionedTransaction; mint?: string }> {
  const paths = ["/api/create-token-local", "/api/create-token", "/api/trade-local"];
  let lastErr: any;
  for (const p of paths) {
    try {
      const r = await fetchFirstOk(p, {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify(body),
      }, 2);
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
      if (j?.mint && (j?.tx || j?.transaction)) {
        const b64 = j.tx || j.transaction;
        const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
        return { tx: VersionedTransaction.deserialize(raw), mint: j.mint };
      }

      lastErr = new Error("Unknown create-token response format");
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error("Pump create endpoint failed");
}

/* ---------- Lightning API ---------- */
async function uploadIpfsMeta(params: {
  name: string; symbol: string; image: string; description?: string; website?: string; twitter?: string;
}) {
  const r = await fetchFirstOk("/api/ipfs", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify({
      name: params.name, symbol: params.symbol, description: params.description || "",
      image: params.image, website: params.website || "", twitter: params.twitter || "",
    }),
  }, 2);
  const j = await r.json().catch(() => ({}));
  const uri = j?.uri || j?.ipfsUri || j?.metadataUri;
  if (!uri) throw new Error("IPFS upload failed (no uri)");
  return String(uri);
}

async function buildCreateViaLightning(args: {
  name: string; symbol: string; image: string;
  description?: string; website?: string; twitter?: string;
  initialBuySol?: number; slippagePct?: number; priorityFeeSol?: number;
}) {
  const uri = await uploadIpfsMeta({
    name: args.name, symbol: args.symbol, image: args.image,
    description: args.description, website: args.website, twitter: args.twitter,
  });

  const payload = {
    action: "create",
    tokenMetadata: { name: args.name, symbol: args.symbol, uri },
    denominatedInSol: "true",
    amount: Number(args.initialBuySol || 0),
    slippage: Number(args.slippagePct ?? 10),
    priorityFee: Number(args.priorityFeeSol ?? 0.00001),
    pool: "pump",
  };

  const r = await fetchFirstOk("/api/trade", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    body: JSON.stringify(payload),
  }, 2);

  const j = await r.json().catch(() => ({}));
  const mint = j?.mint || j?.token || j?.tokenAddress || j?.address;
  const signature = j?.signature || j?.txSignature || j?.sig;
  if (!mint) throw new Error("Lightning create: no mint in response");
  return { mint: String(mint), signature: signature ? String(signature) : undefined };
}

/* ---------- helpers ---------- */
async function detectTokenProgram(connection: Connection, mint: PublicKey) {
  try {
    const info = await connection.getAccountInfo(mint);
    return info?.owner?.equals(TOKEN_2022_PROGRAM_ID) ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID;
  } catch {
    // Fail-safe: если RPC дал странный ответ — используем классический TOKEN_PROGRAM_ID
    return TOKEN_PROGRAM_ID;
  }
}

// Быстрое чтение decimals из raw Mint-аккаунта (offset 44, u8). Без парсинга.
async function getMintDecimalsFast(connection: Connection, mint: PublicKey): Promise<number | null> {
  try {
    const infos = await connection.getMultipleAccountsInfo([mint]);
    const acc = infos?.[0] || null;
    const data = (acc?.data as any) as Uint8Array | undefined;
    if (data && data.byteLength >= 45) return data[44];
  } catch {}
  try {
    const info = await connection.getAccountInfo(mint);
    const data = (info?.data as any) as Uint8Array | undefined;
    if (data && data.byteLength >= 45) return data[44];
  } catch {}
  return null;
}

async function ensureWalletAta(connection: Connection, walletPubkey: string, mint: string) {
  const ph = (window as any).solana;
  const mintPk = new PublicKey(mint);
  const walletPk = new PublicKey(walletPubkey);

  // Попробуем оба варианта программ, чтобы не падать при сбое detect
  const programGuess = await detectTokenProgram(connection, mintPk);
  const candidates = [programGuess, programGuess === TOKEN_2022_PROGRAM_ID ? TOKEN_PROGRAM_ID : TOKEN_2022_PROGRAM_ID];

  for (const programId of candidates) {
    const ata = await getAssociatedTokenAddress(mintPk, walletPk, false, programId);
    try {
      const info = await connection.getAccountInfo(ata);
      if (info) return ata;
    } catch {}
  }

  // Создадим с предполагаемой программой, при ошибке попробуем второй
  for (const programId of candidates) {
    try {
      const ata = await getAssociatedTokenAddress(mintPk, walletPk, false, programId);
      const ix = createAssociatedTokenAccountInstruction(walletPk, ata, walletPk, mintPk, programId);
      const { blockhash } = await connection.getLatestBlockhash();
      const tx = new Transaction({ feePayer: walletPk, recentBlockhash: blockhash }).add(ix);
      if (!ph?.signAndSendTransaction) throw new Error("Phantom не поддерживает signAndSendTransaction");
      const { signature } = await ph.signAndSendTransaction(tx);
      await confirmSigHttp(connection, signature);
      return ata;
    } catch (e) {
      // попробуем следующий programId
    }
  }
  throw new Error("ensureWalletAta: failed to create ATA for wallet");
}

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
      const { blockhash } = await connection.getLatestBlockhash("finalized");
      const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: toPk, lamports });
      const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
      tx.sign(kp);
      const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 3 });
      await confirmSigHttp(connection, sig);
      return sig;
    } catch (e: any) {
      const m = e?.message || String(e);
      lastErr = m;
      await new Promise((r) => setTimeout(r, 300));
    }
  }
  throw new Error(lastErr || "block height exceeded after retries");
}

/* ===== Misc types & sanitizers ===== */
export type SmartMM = {
  enabled: boolean;
  minBps: number;
  maxBps: number;
  alpha: number;
  twapSec: number;
  twapSlices: number;
};

const toNum = (x: any, d: number) => (Number.isFinite(Number(x)) ? Number(x) : d);
const safeBps = (bps: any, fallback = 50) =>
  Math.min(2000, Math.max(1, Math.round(toNum(bps, fallback))));

const sanitizeSmartMM = (mm?: Partial<SmartMM>): SmartMM => {
  const m: any = mm || {};
  const min = Math.max(1, toNum(m.minBps, 20));
  const max = Math.max(min, toNum(m.maxBps, 200));
  return {
    enabled: !!m.enabled,
    minBps: min,
    maxBps: max,
    alpha: Math.min(0.99, Math.max(0.01, toNum(m.alpha, 0.6))),
    twapSec: Math.max(0, Math.floor(toNum(m.twapSec, 120))),
    twapSlices: Math.max(1, Math.floor(toNum(m.twapSlices, 4))),
  };
};

/* ===== Store ===== */
export type Store = {
  tokenUrl: string;
  tokenMint: string | null;
  price: number;
  candles: { t: number; open: number; high: number; low: number; close: number; volume: number }[];

  /** быстрые тики за последнюю минуту (для импульса 10–15 сек) */
  ticks: { t: number; p: number }[];
  /** быстрый импульс: изменение цены за последние `sec` секунд */
  getChangeFast: (sec?: number) => number;

  external: {
    provider: "dexscreener" | "jupiter" | "solanatracker" | "pumpportal" | "custom";
    endpoint: string;
    apiKey?: string;
  };

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

  createPumpToken: (
    connection: Connection,
    creatorPubkey: string,
    params: {
      name: string; symbol: string; image: string;
      description?: string; website?: string; twitter?: string; decimals?: number; initialBuySol?: number;
    }
  ) => Promise<void>;

  buyAllBotsOnPump: (connection: Connection, opts?: { keepFeeSol?: number }) => Promise<void>;
  buyAllBotsAtPercentOnPump: (connection: Connection, percent: number, opts?: { keepFeeSol?: number }) => Promise<void>;
  buyAllBots80OnPump: (connection: Connection, opts?: { keepFeeSol?: number }) => Promise<void>;

  sellAllToWalletOnPump: (connection: Connection, walletPubkey: string, opts?: { keepFeeSol?: number }) => Promise<void>;

  autoMode: boolean;
  autoCfg: { slopeLookback: number; volLookback: number; slopeThr: number; volThr: number };
  autoTick: () => void;

  _mintDecimals?: number;
  _lastTopUp?: Record<string, number>;
  _ppSub?: any;

  // Аллокация токен/SOL (цель и коридор), управляется из UI
  allocTarget: number;    // 0..1
  allocMin: number;       // нижняя граница, ребаланс в покупку
  allocMax: number;       // верхняя граница, ребаланс в продажу
  setAlloc: (t: number, min: number, max: number) => void;
  getAlloc: () => { target: number; min: number; max: number };

  // Размер шага сделки и форма исполнения (уменьшили шаги для снижения импакта)
  tradeStepMinSol: number;
  tradeStepMaxSol: number;
  tradeSlicesMax: number;
  tradeJitterPct: number;
  setTradeStep: (minSol: number, maxSol: number, slicesMax: number, jitterPct: number) => void;
  getTradeStep: () => { minSol: number; maxSol: number; slicesMax: number; jitterPct: number };

  // Риск-настройки (пока без UI; при желании вынесем в контролы)
  getRisk: () => {
    maxImpact: number;          // максимум допустимой оценочной просадки котировки (0.0..1.0)
    maxDrawdown: number;        // защита портфеля (0.0..1.0)
    reserveSol: number;         // резерв SOL, ниже которого не покупаем
    maxNotionalPerMin: number;  // лимит закупок SOL в минуту на бота
    maxBuysPerMin: number;      // максимум покупок/мин
    maxSellsPerMin: number;     // максимум продаж/мин
    lossThrPct: number;         // падение после покупки, считаем как «неудачную» (например 0.8%)
    lossWindowMs: number;       // окно наблюдения для неудачной покупки
    lossCooldownMs: number;     // пауза покупок после серии неудачных
    maxBuySliceSol: number;     // максимум SOL на один buy-срез
    maxSellSliceTokPct: number; // максимум процента позиции на один sell-срез
    minSliceGapMs: number;      // минимальная пауза между срезами
    maxSliceGapMs: number;      // максимальная пауза между срезами
  };
};

export const useStore = create<Store>()(
  persist(
    (set, get) => ({
      tokenUrl: "",
      tokenMint: null,
      price: 0,
      candles: [],

      ticks: [],
      getChangeFast(sec = 15) {
        const st = get();
        if (!st.ticks.length) return 0;
        const tnow = Date.now();
        const since = tnow - sec * 1000;
        let base = st.ticks[0].p;
        for (let i = st.ticks.length - 1; i >= 0; i--) {
          if (st.ticks[i].t <= since) { base = st.ticks[i].p; break; }
        }
        const curr = st.price || (st.ticks as any).at?.(-1)?.p || base;
        return (curr - base) / Math.max(1e-9, base);
      },

      external: { provider: "dexscreener", endpoint: "https://api.dexscreener.com" },

      log: [],
      addLog: (level, msg) => set((s) => ({ log: [...s.log, { ts: now(), level, msg }].slice(-800) })),

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
        const mm = sanitizeSmartMM(s.smartMM);
        if (!mm.enabled) return safeBps(s.slippageBps, 50);
        const cs = s.candles;
        if (cs.length < 6) return Math.round((mm.minBps + mm.maxBps) / 2);

        const last = cs.slice(-5);
        const p0 = last[0].close;
        const p1 = last[last.length - 1].close;
        const slope = (p1 - p0) / Math.max(1e-9, p0);
        const mean = last.reduce((a, c) => a + c.close, 0) / last.length;
        const sd = Math.sqrt(last.reduce((a, c) => a + (c.close - mean) ** 2, 0) / last.length) / Math.max(1e-9, mean);
        const sNorm = Math.min(1, Math.abs(slope) / 0.02);
        const vNorm = Math.min(1, sd / 0.01);

        const w = mm.alpha;
        const score = w * sNorm + (1 - w) * vNorm;
        const bps = mm.minBps + score * (mm.maxBps - mm.minBps);
        return safeBps(bps, 50);
      },

      getTwapPlan() {
        const mm = sanitizeSmartMM(get().smartMM);
        if (!mm.enabled || mm.twapSlices < 2 || mm.twapSec <= 0) return null;
        const gapMs = Math.floor((mm.twapSec * 1000) / mm.twapSlices);
        return { slices: mm.twapSlices, gapMs: Math.max(0, gapMs) };
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
            try { (s as any)._ppSub?.detach?.(); } catch {}
            const sub = attachPumpPortalFeed({
              mint,
              onPrice: (p) =>
                set((st) => {
                  const tnow = Date.now();
                  const ticks = (st.ticks || []).concat({ t: tnow, p });
                  const cut = tnow - 60_000;
                  return { price: p, ticks: ticks.filter((x) => x.t > cut) };
                }),
              onCandle: (m, p) =>
                set((st) => {
                  const last = (st.candles as any).at?.(-1);
                  let c = st.candles.slice();
                  if (!last || last.t !== m) c.push({ t: m, open: p, high: p, low: p, close: p, volume: 0 });
                  else { last.high = Math.max(last.high, p); last.low = Math.min(last.low, p); last.close = p; }
                  if (c.length > 1000) c = c.slice(-1000);
                  return { candles: c };
                }),
              onMigration: () => get().addLog("info", "Token migrated from bonding curve → Raydium"),
            });
            set((s2) => ({ ...s2, external: { ...s2.external, provider: "pumpportal" }, _ppSub: sub }));
          });
        } else {
          try { (get() as any)._ppSub?.detach?.(); } catch {}
          set({ _ppSub: undefined });
        }
      },

      addBot: (name) => {
        const rec = createKey(name || `Bot#${get().bots.length + 1}`);
        const bot: LiveBot = {
          id: rec.id, name: rec.name, pubkey: rec.pubkey, keyId: rec.id,
          strategy: "trend", budgetSol: 0.02, speedMs: 8000, running: false, aiEnabled: true,
          manualLock: false, solBalance: 0, tokenBalance: 0, posToken: 0, avgSol: 0,
          realized: 0, unrealized: 0, fills: 0,
        };
        set((s) => ({ bots: [...s.bots, bot] }));
        get().addLog("ok", `Создан суб-кошелёк ${bot.name}: ${bot.pubkey}`);
      },

      importBotFromSecret: (name, secretB64) => {
        const rec = importKey(name || `BotImported#${get().bots.length + 1}`, secretB64);
        const bot: LiveBot = {
          id: rec.id, name: rec.name, pubkey: rec.pubkey, keyId: rec.id,
          strategy: "trend", budgetSol: 0.02, speedMs: 8000, running: false, aiEnabled: true,
          manualLock: false, solBalance: 0, tokenBalance: 0, posToken: 0, avgSol: 0,
          realized: 0, unrealized: 0, fills: 0,
        };
        set((s) => ({ bots: [...s.bots, bot] }));
        get().addLog("ok", `Импортирован ключ для ${bot.name}: ${bot.pubkey}`);
      },

      // ===== CRUD над настройками из UI
      updateBot: (id: string, patch: Partial<LiveBot>) => {
        set((s) => {
          const bots = s.bots.map((b) => (b.id === id ? { ...b, ...patch } : b));
          return { bots };
        });
      },

      removeBot: (id: string) => {
        try { removeKey(id); } catch {}
        set((s) => ({ bots: s.bots.filter((b) => b.id !== id) }));
      },

      exportBotKey: (id: string) => {
        try { return exportSecret(id); } catch { return null; }
      },

      // Пополнение из Treasury
      async topUpBot(connection, botId) {
        const s = get();
        const bot = s.bots.find((b) => b.id === botId);
        if (!bot) return;
        const kpId = s.treasuryKeyId;
        if (!kpId) { s.addLog("warn", "Не задан Treasury — пополнение невозможно"); return; }
        const kp = getKeypair(kpId);
        const need = Math.max(0, s.topUpToSol - bot.solBalance);
        if (need <= 0) return;
        try {
          const ix = SystemProgram.transfer({
            fromPubkey: kp.publicKey,
            toPubkey: new PublicKey(bot.pubkey),
            lamports: Math.ceil(need * LAMPORTS_PER_SOL),
          });
          const { blockhash } = await connection.getLatestBlockhash("finalized");
          const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
          tx.sign(kp);
          const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          await confirmSigHttp(connection, sig);
          s.addLog("ok", `Top-up для ${bot.name}: +${need.toFixed(6)} SOL (${sig})`);
        } catch (e: any) {
          s.addLog("err", `Top-up error: ${e?.message || String(e)}`);
        }
      },

      // Drain (HTTP-confirm)
      async drainBotTo(connection, botId, destAddress) {
        const s = get();
        const bot = s.bots.find((b) => b.id === botId);
        if (!bot) return;
        const dest = new PublicKey(destAddress);

        const keep = Math.max(s.drainMinKeepSol, s.minFeeSol);
        let sendSol = bot.solBalance - keep - 0.00001;
        if (sendSol <= 0) { s.addLog("info", `Drain ${bot.name}: нечего отправлять (баланс ${bot.solBalance.toFixed(6)} SOL)`); return; }
        sendSol = Math.max(0, +sendSol.toFixed(6));
        const lamports = Math.floor(sendSol * LAMPORTS_PER_SOL);
        if (lamports <= 0) { s.addLog("info", `Drain ${bot.name}: слишком мало для перевода`); return; }

        try {
          const kp = getKeypair(bot.keyId);
          const ix = SystemProgram.transfer({ fromPubkey: kp.publicKey, toPubkey: dest, lamports });
          const { blockhash } = await connection.getLatestBlockhash("finalized");
          const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
          tx.sign(kp);
          const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
          await confirmSigHttp(connection, sig);
          s.addLog("ok", `Drain ${bot.name} → ${dest.toBase58().slice(0, 4)}…: ${sendSol.toFixed(6)} SOL (${sig})`);
        } catch (e: any) {
          s.addLog("err", `Drain error ${bot.name}: ${e?.message || e}`);
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
        if (!s.tokenMint) { s.addLog("warn", "Warm-up: mint не задан"); return; }
        const mintPk = new PublicKey(s.tokenMint);

        for (const bot of s.bots) {
          if (bot.solBalance < s.minFeeSol) {
            if (s.autoTopUp && s.treasuryKeyId) {
              try { await get().topUpBot(connection, bot.id); } catch {}
              await get().refreshBalances(connection);
            } else {
              s.addLog("warn", `Warm-up: пропуск ${bot.name} — мало SOL и нет авто-доната`);
              continue;
            }
          }

          if (get().warmupCfg.ensureATA) {
            try {
              const owner = new PublicKey(bot.pubkey);
              const programId = await detectTokenProgram(connection as Connection, mintPk);
              const ata = await getAssociatedTokenAddress(mintPk, owner, false, programId);
              const info = await connection.getAccountInfo(ata);
              if (!info) {
                const kp = getKeypair(bot.keyId);
                const ix = createAssociatedTokenAccountInstruction(kp.publicKey, ata, owner, mintPk, programId);
                const { blockhash } = await connection.getLatestBlockhash("finalized");
                const tx = new Transaction({ feePayer: kp.publicKey, recentBlockhash: blockhash }).add(ix);
                tx.sign(kp);
                const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
                await confirmSigHttp(connection, sig);
                s.addLog("ok", `Warm-up: создан ATA для ${bot.name}: ${ata.toBase58()} (${sig})`);
              }
            } catch (e: any) { s.addLog("err", `Warm-up ATA ${bot.name}: ${e?.message || e}`); }
          }

          try {
            const kp = getKeypair(bot.keyId);
            for (let i = 0; i < get().warmupCfg.simulatePerBot; i++) {
              const memoIx = new TransactionInstruction({ keys: [], programId: MEMO_PROGRAM_ID, data: Buffer.from(`warmup:${Date.now()}:${i}`) });
              const tx = new Transaction().add(memoIx);
              tx.feePayer = kp.publicKey;
              tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
              tx.sign(kp);
              await connection.simulateTransaction(tx, { sigVerify: false });
              await new Promise((r) => setTimeout(r, get().warmupCfg.gapMs));
            }
            s.addLog("ok", `Warm-up: симуляции выполнены для ${bot.name}`);
          } catch (e: any) { s.addLog("warn", `Warm-up simulate ${bot.name}: ${e?.message || e}`); }
        }

        await get().refreshBalances(connection);
      },

      // MAINNET warm-up
      mainnetWarmupCfg: { txPerBot: 30, lamports: 5_000, gapMs: 1200, maxTotalSolPerBot: 0.005 },

      async mainnetWarmupTransfers(connection, opts = {}) {
        const s = get();
        const ep = (connection as any)?.rpcEndpoint || "";
        if (/devnet|testnet/i.test(ep)) { s.addLog("warn", "Mainnet warm-up доступен только на mainnet RPC"); return; }

        const bots = s.bots;
        if (bots.length < 2) { s.addLog("warn", "Нужно ≥2 бота для кольцевых переводов"); return; }

        const cfg = { ...s.mainnetWarmupCfg, ...opts };
        const { txPerBot, lamports, gapMs, maxTotalSolPerBot } = cfg;

        const feeLamports = 5_000;
        const estPerTx = lamports + feeLamports;
        const estPerBotLam = txPerBot * estPerTx;
        const estPerBotSol = estPerBotLam / LAMPORTS_PER_SOL;

        if (estPerBotSol > maxTotalSolPerBot) {
          s.addLog("warn", `Warm-up остановлен: расчётная трата ${estPerBotSol.toFixed(6)} SOL/бот > лимита ${maxTotalSolPerBot}`);
          return;
        }

        for (const b of bots) {
          if (b.solBalance < estPerBotSol + s.minFeeSol) {
            s.addLog("warn", `Warm-up: у ${b.name} мало SOL (${b.solBalance.toFixed(6)}), требуется ≥ ${(estPerBotSol + s.minFeeSol).toFixed(6)} SOL`);
          }
        }

        s.addLog("info", `Mainnet warm-up: ${txPerBot} tx/бот, ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL/tx, лимит ~${estPerBotSol.toFixed(6)} SOL/бот`);

        for (const sender of bots) {
          const kp = getKeypair(sender.keyId);
          if (!kp) { s.addLog("err", `Нет ключа для ${sender.name}`); continue; }

          const idx = bots.findIndex((x) => x.id === sender.id);
          const receiver = bots[(idx + 1) % bots.length];
          const toPk = new PublicKey(receiver.pubkey);

          for (let i = 0; i < txPerBot; i++) {
            try {
              const sig = await sendTransferWithRetry(connection as Connection, kp, toPk, lamports, 3);
              s.addLog("ok", `Warm-up ${sender.name} → ${receiver.name}: ${(lamports / LAMPORTS_PER_SOL).toFixed(6)} SOL (${i + 1}/${txPerBot}) ${sig.slice(0, 8)}…`);
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
            s.addLog("warn", `Бот ${bot.name} НЕ запущен: мало SOL (есть ${bot.solBalance.toFixed(6)}, нужно ≥ ${s.minFeeSol})`);
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
          slippageBps: () => safeBps(get().getSmartBps(), 50),
          twap: get().getTwapPlan(),

          price: () => get().price,
          changeFast: (secs?: number) => get().getChangeFast(secs ?? 15),
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

          // читаем флажок AI «на лету»
          isAiPaused: () => {
            const curr = get().bots.find((x) => x.id === bot.id);
            return !(curr?.aiEnabled);
          },

          onLog: (lvl, msg) => get().addLog(lvl, msg),

          // Обновляем только рантайм-поля
          onUpdate: (patch: any) =>
            set((st) => ({
              bots: st.bots.map((x) => {
                if (x.id !== patch.id) return x;
                return {
                  ...x,
                  last: patch.last,
                  lastError: patch.lastError,
                  fills: patch.fills,
                  posToken: patch.posToken,
                  avgSol: patch.avgSol,
                  realized: patch.realized,
                  unrealized: patch.unrealized,
                  solBalance: patch.solBalance ?? x.solBalance,
                  tokenBalance: patch.tokenBalance ?? x.tokenBalance,
                };
              }),
            })),

          // после сделки мягкий refresh (SOL + токен) для всех ботов
          afterTrade: () => {
            // Быстрый рефреш спустя небольшую задержку — улучшает UX
            setTimeout(() => { get().refreshBalances(connection).catch(() => {}); }, 800);
          },
          getAlloc: () => get().getAlloc(),
          getTradeStep: () => get().getTradeStep(),
        } as any);

        (bot as any).__stop = stop;
      },

      stopBot: (id) =>
        set((s) => {
          const b = s.bots.find((x) => x.id === id);
          if (b && (b as any).__stop) { try { (b as any).__stop(); } catch {} delete (b as any).__stop; }
          if (b) b.running = false;
          return { bots: [...s.bots] };
        }),

      startAll: (connection) => { get().bots.forEach((b) => get().startBot(b.id, connection)); },
      stopAll: () => { get().bots.forEach((b) => get().stopBot(b.id)); },

      // ===== Балансы + авто-донат =====
      async refreshBalances(connection) {
        try {
          // простая защита от наложений
          if ((get() as any)._rbBusy) return;
          (get() as any)._rbBusy = true;
          const s = get();
          const mint = s.tokenMint || null;

          // выясняем decimals токена (если mint известен)
          let decimals: number | null = null;
          if (mint) {
            try {
              let d = s._mintDecimals;
              if (d == null) { d = await getMintDecimals(connection, mint); set({ _mintDecimals: d }); }
              decimals = d ?? 9;
            } catch { decimals = 9; }
          }

          const botsList = get().bots;
          if (!botsList.length) return;

          const priceNow = get().price || 0;
          const chunk = (arr: any[], n: number) => { const out:any[]=[]; for (let i=0;i<arr.length;i+=n) out.push(arr.slice(i,i+n)); return out; };

          // 1) SOL balances
          const walletPks = botsList.map(b => new PublicKey(b.pubkey));
          const solInfos: (import("@solana/web3.js").AccountInfo<Buffer> | null)[] = [];
          for (const part of chunk(walletPks, 100)) {
            const infos = await connection.getMultipleAccountsInfo(part as any);
            solInfos.push(...infos);
          }

          // 2) Token ATAs (classic + 2022)
          let ataClassic: import("@solana/web3.js").PublicKey[] = [];
          let ata2022: import("@solana/web3.js").PublicKey[] = [];
          if (mint && decimals != null) {
            const mintPk = new PublicKey(mint);
            for (const b of botsList) {
              const ownerPk = new PublicKey(b.pubkey);
              ataClassic.push(await getAssociatedTokenAddress(mintPk, ownerPk, false, TOKEN_PROGRAM_ID));
              ata2022.push(await getAssociatedTokenAddress(mintPk, ownerPk, false, TOKEN_2022_PROGRAM_ID));
            }
          }

          const ataInfos = new Map<string, import("@solana/web3.js").AccountInfo<Buffer> | null>();
          const allAtas = [...ataClassic, ...ata2022].filter(Boolean) as import("@solana/web3.js").PublicKey[];
          if (allAtas.length) {
            for (const part of chunk(allAtas, 100)) {
              const infos = await connection.getMultipleAccountsInfo(part as any);
              for (let i=0;i<part.length;i++) ataInfos.set(part[i].toBase58(), infos[i]);
            }
          }

          const decodeAmount = (acc: import("@solana/web3.js").AccountInfo<Buffer> | null): number => {
            if (!acc) return 0;
            const data = acc.data as unknown as Uint8Array;
            if (!data || data.byteLength < 72) return 0;
            const view = new DataView(data.buffer, data.byteOffset + 64, 8);
            const lo = view.getUint32(0, true), hi = view.getUint32(4, true);
            const full = (BigInt(hi) << 32n) + BigInt(lo);
            return Number(full);
          };

          const updated = botsList.map((b, idx) => {
            const acc = solInfos[idx];
            const sol = acc ? (acc.lamports || 0) / LAMPORTS_PER_SOL : b.solBalance;
            let tok = b.tokenBalance;
            if (mint && decimals != null && ataClassic.length) {
              const aClassic = ataClassic[idx]?.toBase58();
              const a22 = ata2022[idx]?.toBase58();
              const hasClassic = !!(aClassic && ataInfos.has(aClassic));
              const has22 = !!(a22 && ataInfos.has(a22));
              const accClassic = hasClassic ? (ataInfos.get(aClassic!) || null) : null;
              const acc22 = has22 ? (ataInfos.get(a22!) || null) : null;
              if (hasClassic || has22) {
                const rawC = decodeAmount(accClassic);
                const raw22 = decodeAmount(acc22);
                const rawSum = (rawC || 0) + (raw22 || 0);
                tok = rawSum / Math.pow(10, decimals);
              }
            }
            const unreal = b.posToken * (priceNow - (b.avgSol || priceNow));
            return { ...b, solBalance: sol, tokenBalance: tok, unrealized: unreal };
          });

          // Fallback для тех, у кого токенBalance остался 0, но posToken > 0: точечный getSPLBalance
          if (mint && decimals != null) {
            for (let i = 0; i < updated.length; i++) {
              const b = updated[i];
              if (b.posToken > 0 && b.tokenBalance <= 0) {
                try {
                  const raw = await getSPLBalance(connection, b.pubkey, mint);
                  const tok = Number(raw) / Math.pow(10, decimals);
                  if (tok > 0) updated[i] = { ...b, tokenBalance: tok };
                } catch {}
              }
            }
          }

          set({ bots: updated });

          // авто-донат
          const { autoTopUp, minFeeSol, topUpBot } = get();
          if (autoTopUp) {
            const nowTs = Date.now();
            const last = get()._lastTopUp || {};
            for (const b of updated) {
              if (b.solBalance < minFeeSol) {
                if (!last[b.id] || nowTs - last[b.id] > 30_000) {
                  try { await topUpBot(connection, b.id); } catch {}
                  last[b.id] = Date.now();
                }
              }
            }
            set({ _lastTopUp: last });
          }
        } catch (e) {
          get().addLog("warn", `refreshBalances: ${e?.message || String(e)}`);
        } finally {
          (get() as any)._rbBusy = false;
        }
      },

      // Прайс/свечи + тики
      async tickReal() {
        const s = get();
        if (!s.tokenMint) return;
        if (s.external.provider === "pumpportal") {
          // даже при WS‑цене иногда подёргиваем балансы
          const now = Date.now();
          if (!((s as any)._lastLightRefresh)) (s as any)._lastLightRefresh = 0;
          if (now - (s as any)._lastLightRefresh > 8000) {
            (s as any)._lastLightRefresh = now;
            try { await get().refreshBalances((window as any).__conn || ({} as any)); } catch {}
          }
          return;
        }

        const tryOnce = async (prov: any) => {
          try {
            return await fetchExternalPrice({ ...prov, endpoint: prov.endpoint, apiKey: prov.apiKey }, s.tokenMint!);
          } catch { return null; }
        };

        const candidates = [
          s.external,
          { provider: "dexscreener", endpoint: "https://api.dexscreener.com" },
          { provider: "jupiter", endpoint: "https://price.jup.ag" },
          { provider: "solanatracker", endpoint: "https://api.solanatracker.io" },
        ];

        let p: number | null = null;
        for (const c of candidates) {
          p = await tryOnce(c);
          if (p && isFinite(p) && p > 0) break;
        }
        if (!p) return;

        set((st) => {
          const t = Date.now();
          const m = Math.floor(t / 60000) * 60000;
          const last = (st.candles as any).at?.(-1);
          let c = st.candles.slice();
          if (!last || last.t !== m) c.push({ t: m, open: p!, high: p!, low: p!, close: p!, volume: 0 });
          else { last.high = Math.max(last.high, p!); last.low = Math.min(last.low, p!); last.close = p!; }
          if (c.length > 1000) c = c.slice(-1000);

          const now = Date.now();
          const ticks = (st.ticks || []).concat({ t: now, p: p! });
          const cut = now - 60_000;

          const bots = st.bots.map((b) => ({ ...b, unrealized: b.posToken * (p! - (b.avgSol || p!)) }));
          return { price: p!, candles: c, bots, ticks: ticks.filter((x) => x.t > cut) };
        });
      },

      // === Pump: создать токен и автопокупка ===
      async createPumpToken(connection, creatorPubkey, params) {
        try {
          const slippagePct = safeBps(get().getSmartBps(), 50) / 100;
          const { mint, signature } = await buildCreateViaLightning({
            name: params.name, symbol: params.symbol, image: params.image,
            description: params.description, website: params.website, twitter: params.twitter,
            initialBuySol: params.initialBuySol || 0,
            slippagePct, priorityFeeSol: 0.00001,
          });

          get().addLog("ok", `Token created (Lightning): ${mint}${signature ? ` (${signature.slice(0, 8)}…)` : ""}`);
          set((s) => ({ ...s, tokenUrl: mint, tokenMint: mint, external: { ...s.external, provider: "pumpportal" } }));

          await get().buyAllBotsOnPump(connection, { keepFeeSol: Math.max(0.002, get().minFeeSol) });
          await get().refreshBalances(connection);
          return;
        } catch (e: any) {
          get().addLog("warn", `Lightning create failed → fallback to Local: ${e?.message || String(e)}`);
        }

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
          if (!ph?.signAndSendTransaction) throw new Error("Phantom должен поддерживать signAndSendTransaction (vtx)");
          const { signature } = await ph.signAndSendTransaction(tx);
          await confirmSigHttp(connection, signature);

          const tokenMint = mint || get().tokenMint;
          if (tokenMint) {
            get().addLog("ok", `Token created (Local): ${tokenMint} (${signature.slice(0, 8)}…)`);
            set((s) => ({ ...s, tokenUrl: tokenMint, tokenMint: tokenMint, external: { ...s.external, provider: "pumpportal" } }));
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
        if (!s.tokenMint) { s.addLog("warn", "Auto-buy: mint не задан"); return; }
        for (let i = 0; i < s.bots.length; i++) {
          const b = s.bots[i];
          const spend = Math.max(0, +(b.solBalance - keep).toFixed(6));
          if (spend <= 0) { s.addLog("info", `Auto-buy ${b.name}: нечего тратить`); continue; }
          try {
            // sanity: impact + roundtrip guard
            const dec = s._mintDecimals ?? 9;
            const pay = Math.round(spend * 1e9);
            const q1: any = await getJupiterQuote({ inputMint: WSOL, outputMint: s.tokenMint!, amount: pay });
            const outTok = Number(q1?.outAmount || 0) / Math.pow(10, dec);
            const priceNow = s.price || 0;
            if (outTok > 0 && priceNow > 0) {
              const fairOut = spend / priceNow;
              const impact = Math.max(0, fairOut > 0 ? (1 - outTok / fairOut) : 0);
              if (impact > 0.015) { s.addLog("warn", `Auto-buy ${b.name}: skip (impact ${(impact*100).toFixed(1)}%)`); continue; }
              const q2: any = await getJupiterQuote({ inputMint: s.tokenMint!, outputMint: WSOL, amount: Math.max(1, Math.round(outTok * Math.pow(10, dec))) });
              const backSol = Number(q2?.outAmount || 0) / 1e9;
              const loss = Math.max(0, 1 - backSol / Math.max(1e-12, spend));
              if (loss > 0.006) { s.addLog("warn", `Auto-buy ${b.name}: skip (roundtrip ${(loss*100).toFixed(1)}%)`); continue; }
            }
            const kp = getKeypair(b.keyId);
            const vtx = await buildTradeTxPumpLocal({
              publicKey: kp.publicKey.toBase58(),
              action: "buy",
              mint: s.tokenMint,
              denominatedInSol: "true",
              amount: spend,
              slippage: safeBps(get().getSmartBps(), 50) / 100,
              priorityFee: 0.00001,
              pool: "auto",
            });
            vtx.sign([kp]);
            const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 });
            await confirmSigHttp(connection, sig);
            s.addLog("ok", `Auto-buy ${b.name}: ${spend.toFixed(6)} SOL (${sig.slice(0, 8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `Auto-buy ${s.bots[i].name}: ${e?.message || String(e)}`);
          }
          if (i < s.bots.length - 1) await new Promise((r) => setTimeout(r, 1200));
        }
      },

      /** ===== Новая: все боты покупают на percent своего SOL ===== */
      async buyAllBotsAtPercentOnPump(connection, percent, opts = {}) {
        const keep = Math.max(0.0005, (opts as any).keepFeeSol ?? get().minFeeSol);
        const pct = Math.min(1, Math.max(0, Number(percent) || 0));
        const s = get();
        if (!s.tokenMint) { s.addLog("warn", "Buy%: mint не задан"); return; }

        for (let i = 0; i < s.bots.length; i++) {
          const b = s.bots[i];
          const base = Math.max(0, b.solBalance - keep);
          const spend = Math.max(0, +(base * pct).toFixed(6));
          if (spend <= 0) { s.addLog("info", `Buy% ${b.name}: нечего тратить`); continue; }
          try {
            // sanity: impact + roundtrip guard
            const dec = s._mintDecimals ?? 9;
            const pay = Math.round(spend * 1e9);
            const q1: any = await getJupiterQuote({ inputMint: WSOL, outputMint: s.tokenMint!, amount: pay });
            const outTok = Number(q1?.outAmount || 0) / Math.pow(10, dec);
            const priceNow = s.price || 0;
            if (outTok > 0 && priceNow > 0) {
              const fairOut = spend / priceNow;
              const impact = Math.max(0, fairOut > 0 ? (1 - outTok / fairOut) : 0);
              if (impact > 0.015) { s.addLog("warn", `Buy% ${b.name}: skip (impact ${(impact*100).toFixed(1)}%)`); continue; }
              const q2: any = await getJupiterQuote({ inputMint: s.tokenMint!, outputMint: WSOL, amount: Math.max(1, Math.round(outTok * Math.pow(10, dec))) });
              const backSol = Number(q2?.outAmount || 0) / 1e9;
              const loss = Math.max(0, 1 - backSol / Math.max(1e-12, spend));
              if (loss > 0.006) { s.addLog("warn", `Buy% ${b.name}: skip (roundtrip ${(loss*100).toFixed(1)}%)`); continue; }
            }
            const kp = getKeypair(b.keyId);
            const vtx = await buildTradeTxPumpLocal({
              publicKey: kp.publicKey.toBase58(),
              action: "buy",
              mint: s.tokenMint,
              denominatedInSol: "true",
              amount: spend,
              slippage: safeBps(get().getSmartBps(), 50) / 100,
              priorityFee: 0.00001,
              pool: "auto",
            });
            vtx.sign([kp]);
            const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 3 });
            await confirmSigHttp(connection, sig);
            s.addLog("ok", `Buy% ${b.name}: ${(spend).toFixed(6)} SOL (${sig.slice(0, 8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `Buy% ${s.bots[i].name}: ${e?.message || String(e)}`);
          }
          if (i < s.bots.length - 1) await new Promise((r) => setTimeout(r, 1200));
        }
      },

      async buyAllBots80OnPump(connection, opts = {}) {
        await get().buyAllBotsAtPercentOnPump(connection, 0.8, opts);
      },

      // === Sell ALL — боты → кошелёк → одна продажа
      async sellAllToWalletOnPump(connection, walletPubkey) {
        const s = get();
        if (!s.tokenMint) { s.addLog("warn", "Sell ALL: mint не задан"); return; }

        const mintPk = new PublicKey(s.tokenMint);
        const walletPk = new PublicKey(walletPubkey);
        let decimals = s._mintDecimals;
        if (decimals == null) {
          // Сначала быстрый raw-декод; если не получилось — обычный helper
          const fast = await getMintDecimalsFast(connection as Connection, mintPk);
          decimals = fast ?? null;
          if (decimals == null) {
            try { decimals = await getMintDecimals(connection, s.tokenMint); } catch {}
          }
          if (decimals != null) set({ _mintDecimals: decimals });
        }
        decimals = (decimals ?? 9);

        for (let i = 0; i < s.bots.length; i++) {
          const b = s.bots[i];
          try {
            const kp = getKeypair(b.keyId);
            // Определяем используемую программу по существующему ATA (без getAccountInfo на mint)
            const srcClassic = await getAssociatedTokenAddress(mintPk, kp.publicKey, false, TOKEN_PROGRAM_ID);
            const src22 = await getAssociatedTokenAddress(mintPk, kp.publicKey, false, TOKEN_2022_PROGRAM_ID);
            const dstClassic = await getAssociatedTokenAddress(mintPk, walletPk, false, TOKEN_PROGRAM_ID);
            const dst22 = await getAssociatedTokenAddress(mintPk, walletPk, false, TOKEN_2022_PROGRAM_ID);

            const infos = await connection.getMultipleAccountsInfo([srcClassic, src22, dstClassic, dst22]);
            const [srcCInfo, src22Info, dstCInfo, dst22Info] = infos;

            // локальный декодер amount из ATA
            const decodeAmount = (acc: any): bigint => {
              try {
                if (!acc || !acc.data || acc.data.byteLength < 72) return 0n;
                const view = new DataView(acc.data.buffer, acc.data.byteOffset + 64, 8);
                const lo = view.getUint32(0, true), hi = view.getUint32(4, true);
                return (BigInt(hi) << 32n) + BigInt(lo);
              } catch { return 0n; }
            };

            const amtC = decodeAmount(srcCInfo);
            const amt22 = decodeAmount(src22Info);

            let useProgram = TOKEN_PROGRAM_ID;
            let srcAta = srcClassic; let dstAta = dstClassic; let dstInfo = dstCInfo; let amountRaw = amtC;
            if (amt22 > 0n || (!srcCInfo && src22Info)) { // предпочитаем 2022, если там есть баланс или только он существует
              useProgram = TOKEN_2022_PROGRAM_ID; srcAta = src22; dstAta = dst22; dstInfo = dst22Info; amountRaw = amt22;
            }
            if (amountRaw <= 0n) { s.addLog("info", `Sell ALL: у ${b.name} токенов нет`); continue; }

            const tx = new Transaction();
            if (!dstInfo) tx.add(createAssociatedTokenAccountInstruction(kp.publicKey, dstAta, walletPk, mintPk, useProgram));
            // Если decimals по-прежнему не удалось получить корректно — сделаем transfer без checked
            if (typeof decimals === "number" && Number.isFinite(decimals)) {
              tx.add(createTransferCheckedInstruction(srcAta, mintPk, dstAta, kp.publicKey, amountRaw, decimals, [], useProgram));
            } else {
              // fallback на не-checked передачу
              const { createTransferInstruction } = await import("@solana/spl-token");
              tx.add(createTransferInstruction(srcAta, dstAta, kp.publicKey, amountRaw, [], useProgram));
            }

            const { blockhash } = await connection.getLatestBlockhash("finalized");
            tx.feePayer = kp.publicKey;
            (tx as any).recentBlockhash = blockhash;
            tx.sign(kp);
            const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true });
            await confirmSigHttp(connection, sig);

            s.addLog("ok", `Sell ALL: ${b.name} → wallet ${Number(amountRaw) / Math.pow(10, decimals)} TOK (${sig.slice(0, 8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `Sell ALL transfer ${s.bots[i].name}: ${e?.message || String(e)}`);
          }
          if (i < s.bots.length - 1) await new Promise((r) => setTimeout(r, 1200));
        }

        try {
          const rawWallet = await getSPLBalance(connection, walletPubkey, s.tokenMint);
          const amountTok = Number(rawWallet as any) / Math.pow(10, decimals);
          if (amountTok <= 0) { s.addLog("info", "Sell ALL: на кошельке нет токенов для продажи"); return; }

          const amountRounded = +amountTok.toFixed(Math.min(6, decimals));
          const vtx = await buildTradeTxPumpLocal({
            publicKey: walletPubkey,
            action: "sell",
            mint: s.tokenMint,
            denominatedInSol: "false",
            amount: amountRounded,
            slippage: safeBps(get().getSmartBps(), 50) / 100,
            priorityFee: 0.00001,
            pool: "auto",
          });

          const ph = (window as any).solana;
          if (!ph?.signAndSendTransaction) throw new Error("Phantom не поддерживает signAndSendTransaction");
          const { signature } = await ph.signAndSendTransaction(vtx);
          await confirmSigHttp(connection, signature);
          s.addLog("ok", `Sell ALL: кошелёк продал ~${amountRounded} TOK (${signature.slice(0, 8)}…)`);
        } catch (e: any) {
          get().addLog("err", `Sell ALL sell-phase: ${e?.message || String(e)}`);
        }

        await get().refreshBalances(connection);
      },

      // Авто-профили
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
        const p1 = prices[prices.length - 1].close;
        if (!p0) return;

        const slope = (p1 - p0) / p0;
        const mean = prices.reduce((a, b) => a + b, 0) / prices.length;
        const sd = Math.sqrt(prices.reduce((a, b) => a + (b - mean) * (b - mean), 0) / prices.length) / Math.max(1e-9, mean);

        const trending = Math.abs(slope) > slopeThr;
        const noisy = sd > volThr;

        let desired: Array<{ type: "trend" | "revert" | "scalper"; share: number }>;
        if (trending) {
          desired = noisy
            ? [{ type: "trend", share: 0.6 }, { type: "scalper", share: 0.25 }, { type: "revert", share: 0.15 }]
            : [{ type: "trend", share: 0.7 }, { type: "revert", share: 0.2 }, { type: "scalper", share: 0.1 }];
        } else {
          desired = noisy
            ? [{ type: "revert", share: 0.55 }, { type: "trend", share: 0.3 }, { type: "scalper", share: 0.15 }]
            : [{ type: "revert", share: 0.6 }, { type: "trend", share: 0.3 }, { type: "scalper", share: 0.1 }];
        }

        const bots = [...s.bots];
        const free = bots.filter((b) => !b.manualLock);
        if (free.length === 0) return;

        const total = free.length;
        const counts = desired.map((x) => ({ type: x.type, n: Math.round(x.share * total) }));
        let sum = counts.reduce((a, c) => a + c.n, 0);
        while (sum < total) { counts[0].n++; sum++; }
        while (sum > total) { counts[0].n--; sum--; }

        const profiles = {
          trend:   (i: number) => ({ strategy: "trend"   as const, speedMs: 5000 + ((i % 3) * 2000), budgetSol: 0.02 + ((i % 2) * 0.01) }),
          revert:  (i: number) => ({ strategy: "revert"  as const, speedMs: 9000 + ((i % 3) * 3000), budgetSol: 0.015 }),
          scalper: (i: number) => ({ strategy: "scalper" as const, speedMs: 1500 + ((i % 3) * 500),  budgetSol: 0.008 }),
          momentum:(i: number) => ({ strategy: "momentum"as const, speedMs: 4000 + ((i % 3) * 1500), budgetSol: 0.02 }),
          range:   (i: number) => ({ strategy: "range"   as const, speedMs: 7000 + ((i % 3) * 2000), budgetSol: 0.015 }),
          maker:   (i: number) => ({ strategy: "maker"   as const, speedMs: 2500 + ((i % 3) * 800),  budgetSol: 0.006 }),
        } as const;

        let idx = 0;
        const newBots = bots.map((b) => {
          if (b.manualLock) return b;
          let bucket: BotStrategy = "trend";
          for (const c of counts) { if (c.n > 0) { bucket = c.type as any; c.n--; break; } }
          const prof = profiles[bucket](idx++);
          return { ...b, ...prof };
        });

        set({ bots: newBots });
      },

      // Аллокация по умолчанию: 70% токен / 30% SOL, коридор 60..85
      allocTarget: 0.70,
      allocMin: 0.60,
      allocMax: 0.85,
      setAlloc: (t, min, max) => set({
        allocTarget: Math.min(0.95, Math.max(0.05, Number(t) || 0.7)),
        allocMin: Math.min(0.95, Math.max(0.05, Number(min) || 0.6)),
        allocMax: Math.min(0.98, Math.max(0.06, Number(max) || 0.85)),
      }),
      getAlloc: () => ({ target: get().allocTarget, min: get().allocMin, max: get().allocMax }),

      // Размер шага сделки и форма исполнения (уменьшили шаги для снижения импакта)
      tradeStepMinSol: 0.0002,
      tradeStepMaxSol: 0.0008,
      tradeSlicesMax: 4,
      tradeJitterPct: 0.25,
      setTradeStep: (minSol, maxSol, slicesMax, jitterPct) => set({
        tradeStepMinSol: Math.max(0.00005, Number(minSol) || 0.0002),
        tradeStepMaxSol: Math.max(0.0001, Number(maxSol) || 0.0008),
        tradeSlicesMax: Math.max(1, Math.floor(Number(slicesMax) || 4)),
        tradeJitterPct: Math.min(0.5, Math.max(0, Number(jitterPct) || 0.25)),
      }),
      getTradeStep: () => ({
        minSol: get().tradeStepMinSol,
        maxSol: get().tradeStepMaxSol,
        slicesMax: get().tradeSlicesMax,
        jitterPct: get().tradeJitterPct,
      }),

      // Риск-настройки (пока без UI; при желании вынесем в контролы)
      getRisk: () => ({
        maxImpact: 0.010,
        maxDrawdown: 0.12,
        reserveSol: 0.0060,
        maxNotionalPerMin: 0.0010,
        maxBuysPerMin: 1,
        maxSellsPerMin: 4,
        lossThrPct: 0.003,
        lossWindowMs: 30000,
        lossCooldownMs: 120000,
        maxBuySliceSol: 0.00035,
        maxSellSliceTokPct: 0.035,
        minSliceGapMs: 500,
        maxSliceGapMs: 1600,
      }),
    }),
    {
      name: "meme-bundler:v1",
      version: 3,
      migrate: (persisted: any) => {
        const p = persisted || {};
        p.smartMM = sanitizeSmartMM(p.smartMM);
        p.slippageBps = safeBps(p.slippageBps ?? 50, 50);
        if (!p.tradeRange) p.tradeRange = { minSol: 0.005, maxSol: 0.03 };
        p.tradeRange.minSol = toNum(p.tradeRange.minSol, 0.005);
        p.tradeRange.maxSol = toNum(p.tradeRange.maxSol, 0.03);
        if (typeof p.tradeStepMinSol !== 'number') p.tradeStepMinSol = 0.0003;
        if (typeof p.tradeStepMaxSol !== 'number') p.tradeStepMaxSol = 0.0030;
        if (typeof p.tradeSlicesMax !== 'number') p.tradeSlicesMax = 3;
        if (typeof p.tradeJitterPct !== 'number') p.tradeJitterPct = 0.18;
        // Поддержка аллокации
        if (typeof p.allocTarget !== 'number') p.allocTarget = 0.70;
        if (typeof p.allocMin !== 'number') p.allocMin = 0.60;
        if (typeof p.allocMax !== 'number') p.allocMax = 0.85;
        return p;
      },
      storage: createJSONStorage(() => localStorage),
      partialize: (s) => ({
        tokenUrl: s.tokenUrl,
        tokenMint: s.tokenMint,
        bots: s.bots,
        slippageBps: s.slippageBps,
        useRandomSize: s.useRandomSize,
        tradeRange: s.tradeRange,
        tradeStepMinSol: s.tradeStepMinSol,
        tradeStepMaxSol: s.tradeStepMaxSol,
        tradeSlicesMax: s.tradeSlicesMax,
        tradeJitterPct: s.tradeJitterPct,
        smartMM: s.smartMM,
        allocTarget: s.allocTarget,
        allocMin: s.allocMin,
        allocMax: s.allocMax,
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
          if (u) setTimeout(() => { try { get().setTokenUrl(u); } catch {} }, 0);
        } catch {}
      },
    }
  )
);
