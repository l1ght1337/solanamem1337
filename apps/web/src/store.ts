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
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
} from "@solana/spl-token";
import { fetchExternalPrice } from "./store-price-feeds";
import { getKeypair, createKey, importKey, exportSecret, removeKey } from "./utils/keyring";
import { getMintDecimals, getSPLBalance } from "./utils/solana";
import { scheduleFetch } from "./utils/network";
import { getJupiterQuote, WSOL } from "./utils/jupiter";

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
    keepalive: false,
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

/* ⛑ ГЛОБАЛЬНЫЙ АНТИ-CORS ПАТЧ ДЛЯ JUPITER */
(() => {
  const origFetch = globalThis.fetch?.bind(globalThis);
  if (!origFetch) return;
  const JUP_FORCE_PROXY = String(((import.meta as any).env?.VITE_JUP_FORCE_PROXY ?? '0')).trim() === '1';
  if (!JUP_FORCE_PROXY) return; // по умолчанию не перехватываем
  const needsProxy = (u: string) =>
    /^https:\/\/(quote-api|price)\.jup\.ag\//.test(u);
  globalThis.fetch = ((input: any, init?: RequestInit) => {
    const url = typeof input === "string" ? input : (input?.url ?? "");
    if (typeof url === "string" && needsProxy(url)) {
      try {
        const u = new URL(url);
        return fetchFirstOk(`${JUP_BASE}${u.pathname}${u.search}`, init, 1);
      } catch {}
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
    const raw = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
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

  const programGuess = await detectTokenProgram(connection, mintPk);
  const candidates = [programGuess, programGuess === TOKEN_2022_PROGRAM_ID ? TOKEN_2022_PROGRAM_ID : TOKEN_PROGRAM_ID];

  for (const programId of candidates) {
    const ata = await getAssociatedTokenAddress(mintPk, walletPk, false, programId);
    try {
      const info = await connection.getAccountInfo(ata);
      if (info) return ata;
    } catch {}
  }

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
    } catch {}
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
      lastErr = e?.message || String(e);
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
  const min = Math.max(1, toNum(m.minBps, 15));
  const max = Math.max(min, toNum(m.maxBps, 120));
  return {
    enabled: !!m.enabled,
    minBps: min,
    maxBps: max,
    alpha: Math.min(0.99, Math.max(0.01, toNum(m.alpha, 0.65))),
    twapSec: Math.max(0, Math.floor(toNum(m.twapSec, 150))),
    twapSlices: Math.max(1, Math.floor(toNum(m.twapSlices, 5))),
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

  // Размер шага сделки и форма исполнения
  tradeStepMinSol: number;
  tradeStepMaxSol: number;
  tradeSlicesMax: number;
  tradeJitterPct: number;
  setTradeStep: (minSol: number, maxSol: number, slicesMax: number, jitterPct: number) => void;
  getTradeStep: () => { minSol: number; maxSol: number; slicesMax: number; jitterPct: number };

  // Риск-настройки
  getRisk: () => {
    maxImpact: number;
    maxDrawdown: number;
    reserveSol: number;
    maxNotionalPerMin: number;
    maxBuysPerMin: number;
    maxSellsPerMin: number;
    lossThrPct: number;
    lossWindowMs: number;
    lossCooldownMs: number;
    maxBuySliceSol: number;
    maxSellSliceTokPct: number;
    minSliceGapMs: number;
    maxSliceGapMs: number;
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

      // ↓ более консервативные дефолты smartMM
      smartMM: { enabled: true, minBps: 15, maxBps: 120, alpha: 0.65, twapSec: 150, twapSlices: 5 },

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
            setTimeout(() => { get().refreshBalances(connection).catch(() => {}); }, 800);
          },
          getAlloc: () => get().getAlloc(),
          getTradeStep: () => get().getTradeStep(),
          getRisk: () => get().getRisk(),
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

          const readU64LE = (buf: Uint8Array, off: number): number => {
            let x = 0n;
            for (let i = 0; i < 8; i++) x += BigInt(buf[off + i] ?? 0) << (8n * BigInt(i));
            const max = Number.MAX_SAFE_INTEGER;
            const asNum = Number(x);
            return asNum > max ? max : asNum;
          };

          const decodeAmount = (acc: import("@solana/web3.js").AccountInfo<Buffer> | null): number => {
            if (!acc || decimals == null) return 0;
            const data = acc.data as unknown as Uint8Array;
            if (!data || data.byteLength < 72) return 0;
            const raw = readU64LE(data, 64);
            return raw / Math.pow(10, decimals);
          };

          const updates: Partial<LiveBot & { id: string }>[] = [];
          for (let i = 0; i < botsList.length; i++) {
            const b = botsList[i];
            const solLam = solInfos[i]?.lamports ?? 0;
            let sol = solLam / LAMPORTS_PER_SOL;

            let tok = b.tokenBalance;
            if (mint && decimals != null) {
              const infoClassic = ataClassic[i] ? ataInfos.get(ataClassic[i].toBase58()) ?? null : null;
              const info2022 = ata2022[i] ? ataInfos.get(ata2022[i].toBase58()) ?? null : null;
              const t1 = decodeAmount(infoClassic);
              const t2 = decodeAmount(info2022);
              const decoded = Math.max(t1, t2);
              if (decoded > 0 || (infoClassic || info2022)) tok = decoded;
              else {
                // fallback на медленный способ, если не нашли ATA
                try {
                  const raw = await getSPLBalance(connection, b.pubkey, mint);
                  tok = Number(raw) / Math.pow(10, decimals);
                } catch {}
              }
            }

            // posToken — это "позиция" у раннера. Тут не трогаем, только балансы.
            const unrealized = (b.posToken || tok) * (priceNow - (b.avgSol || priceNow));
            updates.push({ id: b.id, solBalance: sol, tokenBalance: tok, unrealized });
          }

          set((st) => ({
            bots: st.bots.map((x) => {
              const u = updates.find((p) => p.id === x.id);
              if (!u) return x;
              return { ...x, solBalance: u.solBalance ?? x.solBalance, tokenBalance: u.tokenBalance ?? x.tokenBalance, unrealized: u.unrealized ?? x.unrealized };
            }),
          }));

          // авто-донат, если включен (не чаще раза в минуту на бота)
          if (s.autoTopUp && s.treasuryKeyId) {
            const lastMap = s._lastTopUp || {};
            for (const b of get().bots) {
              if (b.solBalance < s.minFeeSol) {
                const last = lastMap[b.id] || 0;
                if (Date.now() - last > 60_000) {
                  try { await get().topUpBot(connection, b.id); } catch {}
                  (lastMap as any)[b.id] = Date.now();
                }
              }
            }
            set({ _lastTopUp: lastMap });
          }
        } catch (e: any) {
          get().addLog("warn", `refreshBalances: ${e?.message || e}`);
        } finally {
          (get() as any)._rbBusy = false;
        }
      },

      async tickReal() {
        try {
          const s = get();
          if (s.external.provider === "pumpportal") return; // стрим уже обновляет
          if (!s.tokenUrl && !s.tokenMint) return;

          const price = await fetchExternalPrice(s.external, s.tokenUrl, s.tokenMint || undefined);
          if (Number.isFinite(price) && price > 0) {
            set((st) => {
              const tnow = Date.now();
              const ticks = (st.ticks || []).concat({ t: tnow, p: price });
              const cut = tnow - 60_000;
              return { price, ticks: ticks.filter((x) => x.t > cut) };
            });
          }
        } catch (e: any) {
          get().addLog("warn", `tickReal: ${e?.message || e}`);
        }
      },

      async createPumpToken(connection, creatorPubkey, params) {
        try {
          const { name, symbol, image, description, website, twitter, initialBuySol = 0 } = params;
          const slippagePct = 10;
          const { mint, signature } = await buildCreateViaLightning({
            name, symbol, image, description, website, twitter, initialBuySol, slippagePct, priorityFeeSol: 0.00001,
          });
          set({ tokenMint: mint, tokenUrl: `https://pump.fun/${mint}`, _mintDecimals: undefined });
          get().addLog("ok", `Создан токен ${symbol} (${name}) mint=${mint}${signature ? ` (${signature.slice(0,8)}…)` : ""}`);

          try { await ensureWalletAta(connection, creatorPubkey, mint); } catch {}
        } catch (e: any) {
          get().addLog("err", `Create token error: ${e?.message || e}`);
        }
      },

      async buyAllBotsOnPump(connection, opts) {
        const keep = Math.max(0.0009, opts?.keepFeeSol ?? get().minFeeSol);
        const slp = safeBps(get().getSmartBps(), 50);
        const s = get();
        if (!s.tokenMint) { s.addLog("warn", "Buy all: mint не задан"); return; }

        for (const b of s.bots) {
          try {
            const have = Math.max(0, b.solBalance - keep);
            const step = s.getTradeSize() || b.budgetSol;
            const pay = Math.min(have, Math.max(0.00005, step));
            if (pay <= 0) { s.addLog("info", `Buy ${b.name}: недостаточно SOL`); continue; }

            const payload = {
              publicKey: getKeypair(b.keyId).publicKey.toBase58(),
              action: "buy",
              mint: s.tokenMint,
              denominatedInSol: "true",
              amount: +pay.toFixed(6),
              slippage: slp / 100,
              priorityFee: 0.00001,
              pool: "auto",
            };

            const vtx = await buildTradeTxPumpLocal(payload);
            const kp = getKeypair(b.keyId);
            vtx.sign([kp]);
            const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 4 });
            await confirmSigHttp(connection, sig);
            s.addLog("ok", `BUY ${b.name}: ${pay.toFixed(6)} SOL (${sig.slice(0,8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `BUY ${b.name} fail: ${e?.message || e}`);
          }
          await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random()*400)));
        }

        await get().refreshBalances(connection);
      },

      async buyAllBotsAtPercentOnPump(connection, percent, opts) {
        const keep = Math.max(0.0009, opts?.keepFeeSol ?? get().minFeeSol);
        const slp = safeBps(get().getSmartBps(), 50);
        const s = get();
        if (!s.tokenMint) { s.addLog("warn", "Buy %: mint не задан"); return; }
        const pc = Math.max(0, Math.min(1, percent));

        for (const b of s.bots) {
          try {
            const have = Math.max(0, b.solBalance - keep);
            const pay = +(have * pc).toFixed(6);
            if (pay <= 0.00005) { s.addLog("info", `Buy% ${b.name}: недостаточно SOL`); continue; }

            const payload = {
              publicKey: getKeypair(b.keyId).publicKey.toBase58(),
              action: "buy",
              mint: s.tokenMint,
              denominatedInSol: "true",
              amount: pay,
              slippage: slp / 100,
              priorityFee: 0.00001,
              pool: "auto",
            };

            const vtx = await buildTradeTxPumpLocal(payload);
            const kp = getKeypair(b.keyId);
            vtx.sign([kp]);
            const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 4 });
            await confirmSigHttp(connection, sig);
            s.addLog("ok", `BUY% ${b.name}: ${pay.toFixed(6)} SOL (${sig.slice(0,8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `BUY% ${b.name} fail: ${e?.message || e}`);
          }
          await new Promise((r) => setTimeout(r, 350 + Math.floor(Math.random()*450)));
        }

        await get().refreshBalances(connection);
      },

      async buyAllBots80OnPump(connection, opts) {
        return get().buyAllBotsAtPercentOnPump(connection, 0.8, opts);
      },

      async sellAllToWalletOnPump(connection, walletPubkey, opts) {
        const s = get();
        const keep = Math.max(0.0009, opts?.keepFeeSol ?? s.minFeeSol);
        if (!s.tokenMint) { s.addLog("warn", "Sell all → wallet: mint не задан"); return; }

        try { await ensureWalletAta(connection, walletPubkey, s.tokenMint); } catch {}

        // 1) Продаём все токены у каждого бота
        for (const b of s.bots) {
          try {
            const decimals = s._mintDecimals ?? (await getMintDecimalsFast(connection, new PublicKey(s.tokenMint)) ?? 9);
            const qtyTok = b.tokenBalance;
            if (qtyTok <= 0) continue;

            const payload = {
              publicKey: getKeypair(b.keyId).publicKey.toBase58(),
              action: "sell",
              mint: s.tokenMint,
              denominatedInSol: "false",
              amount: Number(qtyTok.toFixed(Math.min(6, decimals))),
              slippage: safeBps(get().getSmartBps(), 50) / 100,
              priorityFee: 0.00001,
              pool: "auto",
            };

            const vtx = await buildTradeTxPumpLocal(payload);
            const kp = getKeypair(b.keyId);
            vtx.sign([kp]);
            const sig = await connection.sendRawTransaction(vtx.serialize(), { skipPreflight: true, maxRetries: 4 });
            await confirmSigHttp(connection, sig);
            s.addLog("ok", `SELL ${b.name}: ${qtyTok.toFixed(6)} TOK (${sig.slice(0,8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `SELL ${b.name} fail: ${e?.message || e}`);
          }
          await new Promise((r) => setTimeout(r, 400 + Math.floor(Math.random()*400)));
        }

        await get().refreshBalances(connection);

        // 2) Переводим SOL на кошелёк
        for (const b of get().bots) {
          try {
            const send = Math.max(0, b.solBalance - keep);
            if (send <= 0.00001) continue;
            const lamports = Math.floor(send * LAMPORTS_PER_SOL);
            const kp = getKeypair(b.keyId);
            const sig = await sendTransferWithRetry(connection, kp, new PublicKey(walletPubkey), lamports, 3);
            s.addLog("ok", `→ Wallet ${b.name}: ${send.toFixed(6)} SOL (${sig.slice(0,8)}…)`);
          } catch (e: any) {
            s.addLog("warn", `Transfer ${b.name} → wallet fail: ${e?.message || e}`);
          }
          await new Promise((r) => setTimeout(r, 350 + Math.floor(Math.random()*450)));
        }

        await get().refreshBalances(connection);
      },

      // ===== Авто-режим (лёгкие сигналы)
      autoMode: false,
      autoCfg: { slopeLookback: 10, volLookback: 10, slopeThr: 0.002, volThr: 0.006 },
      autoTick() {
        const s = get();
        if (!s.autoMode) return;
        const cs = s.candles;
        if (!cs.length) return;

        const look = Math.min(cs.length, Math.max(3, s.autoCfg.slopeLookback));
        const last = cs.slice(-look);
        const p0 = last[0].close;
        const p1 = last[last.length - 1].close;
        const slope = (p1 - p0) / Math.max(1e-9, p0);

        const vols = cs.slice(-Math.max(3, s.autoCfg.volLookback));
        const mean = vols.reduce((a, c) => a + c.close, 0) / vols.length;
        const sd = Math.sqrt(vols.reduce((a, c) => a + (c.close - mean) ** 2, 0) / vols.length) / Math.max(1e-9, mean);

        // Простая адаптация стратегии в рантайме
        const newStrat: BotStrategy | null =
          slope > s.autoCfg.slopeThr && sd > s.autoCfg.volThr ? "momentum"
          : slope > s.autoCfg.slopeThr ? "trend"
          : slope < -s.autoCfg.slopeThr ? "revert"
          : null;

        if (newStrat) {
          set((st) => ({ bots: st.bots.map((b) => b.running ? { ...b, strategy: newStrat } : b) }));
        }
      },

      _mintDecimals: undefined,
      _lastTopUp: {},

      // ====== Аллокации
      allocTarget: 0.65,
      allocMin: 0.55,
      allocMax: 0.80,
      setAlloc: (t, min, max) => {
        const target = Math.min(0.95, Math.max(0.05, t));
        const lo = Math.min(target, Math.max(0.05, min));
        const hi = Math.max(target, Math.min(0.98, max));
        set({ allocTarget: target, allocMin: lo, allocMax: hi });
      },
      getAlloc: () => ({ target: get().allocTarget, min: get().allocMin, max: get().allocMax }),

      // ====== Форма исполнения
      tradeStepMinSol: 0.0003,
      tradeStepMaxSol: 0.003,
      tradeSlicesMax: 3,
      tradeJitterPct: 0.18,
      setTradeStep: (minSol, maxSol, slicesMax, jitterPct) => {
        set({
          tradeStepMinSol: Math.max(0.00005, +minSol),
          tradeStepMaxSol: Math.max(+minSol, +maxSol),
          tradeSlicesMax: Math.max(1, Math.round(slicesMax)),
          tradeJitterPct: Math.max(0, Math.min(0.5, +jitterPct)),
        });
      },
      getTradeStep: () => ({
        minSol: get().tradeStepMinSol,
        maxSol: get().tradeStepMaxSol,
        slicesMax: get().tradeSlicesMax,
        jitterPct: get().tradeJitterPct,
      }),

      // ====== Риск
      getRisk: () => ({
        maxImpact: 0.10,
        maxDrawdown: 0.25,
        reserveSol: 0.0012,
        maxNotionalPerMin: 0.02,
        maxBuysPerMin: 6,
        maxSellsPerMin: 10,
        lossThrPct: 0.008,
        lossWindowMs: 20000,
        lossCooldownMs: 20000,
        maxBuySliceSol: 0.0018,
        maxSellSliceTokPct: 0.12,
        minSliceGapMs: 200,
        maxSliceGapMs: 850,
      }),
    }),
    {
      name: "live-bot-store",
      version: 3,
      storage: createJSONStorage(() => localStorage),
      partialize: (s: Store) => ({
        tokenUrl: s.tokenUrl,
        tokenMint: s.tokenMint,
        external: s.external,
        bots: s.bots.map((b) => ({
          id: b.id, name: b.name, strategy: b.strategy, budgetSol: b.budgetSol, speedMs: b.speedMs,
          aiEnabled: b.aiEnabled, manualLock: b.manualLock, keyId: b.keyId, pubkey: b.pubkey,
          solBalance: b.solBalance, tokenBalance: b.tokenBalance, posToken: b.posToken, avgSol: b.avgSol,
          realized: b.realized, unrealized: b.unrealized, fills: b.fills,
        })),
        slippageBps: s.slippageBps,
        useRandomSize: s.useRandomSize,
        tradeRange: s.tradeRange,
        smartMM: s.smartMM,
        treasuryKeyId: s.treasuryKeyId,
        autoTopUp: s.autoTopUp,
        minFeeSol: s.minFeeSol,
        topUpToSol: s.topUpToSol,
        drainMinKeepSol: s.drainMinKeepSol,
        drainDelayMs: s.drainDelayMs,
        autoMode: s.autoMode,
        autoCfg: s.autoCfg,
        allocTarget: s.allocTarget,
        allocMin: s.allocMin,
        allocMax: s.allocMax,
        tradeStepMinSol: s.tradeStepMinSol,
        tradeStepMaxSol: s.tradeStepMaxSol,
        tradeSlicesMax: s.tradeSlicesMax,
        tradeJitterPct: s.tradeJitterPct,
      }),
    }
  )
);
