import {
  Connection,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
  Keypair,
  ComputeBudgetProgram,
} from "@solana/web3.js";
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddress,
  createAssociatedTokenAccountInstruction,
} from "@solana/spl-token";

type Nullable<T> = T | null | undefined;

export type PriorityCfg = {
  minMicroLamports: number;
  maxMicroLamports: number;
  defaultUnits: number;
};

export function readPriorityCfgFromEnv(): PriorityCfg {
  const min = Number((import.meta.env as any).VITE_PRIORITY_FEE_MIN ?? 1000);
  const max = Number((import.meta.env as any).VITE_PRIORITY_FEE_MAX ?? 20000);
  const units = Number((import.meta.env as any).VITE_COMPUTE_UNITS ?? 1_000_000);
  return {
    minMicroLamports: Math.max(0, Math.floor(min)),
    maxMicroLamports: Math.max(0, Math.floor(max)),
    defaultUnits: Math.max(10_000, Math.floor(units)),
  };
}

export function buildPriorityComputeIxs(args?: { microLamports?: number; units?: number }) {
  const cfg = readPriorityCfgFromEnv();
  const price = Math.max(cfg.minMicroLamports, Math.min(cfg.maxMicroLamports, Math.floor(args?.microLamports ?? cfg.minMicroLamports)));
  const units = Math.max(100_000, Math.floor(args?.units ?? cfg.defaultUnits));
  return [
    ComputeBudgetProgram.setComputeUnitLimit({ units }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: price }),
  ];
}

export async function detectTokenProgram(connection: Connection, mint: PublicKey) {
  try {
    const info = await connection.getAccountInfo(mint, "processed");
    if (info?.owner?.equals(TOKEN_2022_PROGRAM_ID)) return TOKEN_2022_PROGRAM_ID;
  } catch {}
  return TOKEN_PROGRAM_ID;
}

export async function ensureAtaIx(args: { connection: Connection; mint: PublicKey; owner: PublicKey; payer: PublicKey; preferProgramId?: PublicKey }) {
  const programId = args.preferProgramId ?? (await detectTokenProgram(args.connection, args.mint));
  const ata = await getAssociatedTokenAddress(args.mint, args.owner, false, programId);
  const info = await args.connection.getAccountInfo(ata, "processed");
  if (info) return { ata, ix: null as TransactionInstruction | null, programId };
  const ix = createAssociatedTokenAccountInstruction(args.payer, ata, args.owner, args.mint, programId);
  return { ata, ix, programId };
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)); }

function parseErrMsg(e: any): string {
  return (e?.message || e?.toString?.() || String(e)) as string;
}

function isBlockhashError(msg: string) {
  return /blockhash/i.test(msg) || /BlockhashNotFound/i.test(msg) || /expired blockhash/i.test(msg);
}

function isAccountInUse(msg: string) { return /AccountInUse/i.test(msg) || /busy/i.test(msg); }
function isSimulationExceeded(msg: string) { return /exceeded/i.test(msg) || /comput/i.test(msg); }

function jitter(minMs: number, maxMs: number) {
  const base = Math.max(0, minMs);
  const spread = Math.max(0, maxMs - minMs);
  return base + Math.floor(Math.random() * (spread + 1));
}

export type SendResult = { signature: string; attempts: number; confirmMs: number };

export async function sendTxWithRetries(args: {
  connection: Connection;
  tx: Transaction;
  signers: Keypair[];
  maxRetries?: number;
  skipPreflight?: boolean;
  computePriceMicroLamports?: number;
  computeUnits?: number;
  onAttempt?: (i: number) => void;
  abortSignal?: AbortSignal;
}): Promise<SendResult> {
  const {
    connection,
    tx,
    signers,
    maxRetries = 6,
    skipPreflight = false,
    computePriceMicroLamports,
    computeUnits,
    onAttempt,
    abortSignal,
  } = args;

  let lastErr: any;
  const startAt = Date.now();

  for (let attempt = 0; attempt < Math.max(1, maxRetries); attempt++) {
    if (abortSignal?.aborted) throw new Error("aborted");
    try {
      onAttempt?.(attempt);
      const latest = await connection.getLatestBlockhash("processed");
      const computeIxs = buildPriorityComputeIxs({ microLamports: computePriceMicroLamports, units: computeUnits });
      const tx2 = new Transaction();
      for (const ix of computeIxs) tx2.add(ix);
      for (const ix of (tx as any).instructions as TransactionInstruction[]) tx2.add(ix);
      tx2.feePayer = tx.feePayer || signers[0].publicKey;
      (tx2 as any).recentBlockhash = latest.blockhash;
      tx2.sign(...signers);
      const wire = tx2.serialize();
      const sig = await connection.sendRawTransaction(wire, { skipPreflight, maxRetries: 0 });
      const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      const confirmMs = Date.now() - startAt;
      noteTxTelemetry(confirmMs, true);
      return { signature: sig, attempts: attempt + 1, confirmMs };
    } catch (e: any) {
      const msg = parseErrMsg(e);
      lastErr = e;
      noteTxTelemetry(Date.now() - startAt, false);
      if (isBlockhashError(msg)) {
        // immediate refresh and retry
        continue;
      }
      if (isAccountInUse(msg)) {
        await sleep(jitter(120, 350));
        continue;
      }
      if (isSimulationExceeded(msg)) {
        await sleep(jitter(180, 400));
        continue;
      }
      // generic backoff
      await sleep(150 + attempt * 200 + Math.floor(Math.random() * 150));
    }
  }
  throw lastErr || new Error("sendTxWithRetries: failed after retries");
}

export async function sendVtxWithRetries(args: {
  connection: Connection;
  buildVtx: () => Promise<VersionedTransaction>;
  maxRetries?: number;
  onAttempt?: (i: number) => void;
  abortSignal?: AbortSignal;
}): Promise<SendResult> {
  const { connection, buildVtx, maxRetries = 5, onAttempt, abortSignal } = args;
  let lastErr: any;
  const startAt = Date.now();
  for (let attempt = 0; attempt < Math.max(1, maxRetries); attempt++) {
    if (abortSignal?.aborted) throw new Error("aborted");
    try {
      onAttempt?.(attempt);
      const vtx = await buildVtx();
      const wire = vtx.serialize();
      const sig = await connection.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 0 });
      const latest = await connection.getLatestBlockhash("processed");
      const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      if (res.value.err) throw new Error(JSON.stringify(res.value.err));
      const confirmMs = Date.now() - startAt;
      noteTxTelemetry(confirmMs, true);
      return { signature: sig, attempts: attempt + 1, confirmMs };
    } catch (e: any) {
      const msg = parseErrMsg(e);
      lastErr = e;
      noteTxTelemetry(Date.now() - startAt, false);
      if (isBlockhashError(msg)) {
        // rebuild on next loop
        continue;
      }
      if (isAccountInUse(msg)) { await sleep(jitter(120, 350)); continue; }
      if (isSimulationExceeded(msg)) { await sleep(jitter(180, 400)); continue; }
      await sleep(150 + attempt * 200 + Math.floor(Math.random() * 150));
    }
  }
  throw lastErr || new Error("sendVtxWithRetries: failed after retries");
}

// lightweight p-limit clone
export function createLimiter(max: number) {
  const limit = Math.max(1, Math.floor(max || 1));
  let active = 0;
  const queue: Array<() => void> = [];
  const next = () => {
    if (active >= limit) return;
    const fn = queue.shift();
    if (!fn) return;
    active++;
    fn();
  };
  const run = async <T,>(cb: () => Promise<T>): Promise<T> => {
    return new Promise<T>((resolve, reject) => {
      const exec = () => {
        cb().then(resolve, reject).finally(() => { active = Math.max(0, active - 1); next(); });
      };
      queue.push(exec);
      next();
    });
  };
  return (cb: () => Promise<any>) => run(cb);
}

// ====== Telemetry (front-only) ======
type Telemetry = {
  sent: number;
  confirmed: number;
  failed: number;
  confirmMs: number[]; // rolling; capped
};

const telemetry: Telemetry = { sent: 0, confirmed: 0, failed: 0, confirmMs: [] };

function noteTxTelemetry(ms: number, ok: boolean) {
  telemetry.sent++;
  if (ok) telemetry.confirmed++; else telemetry.failed++;
  if (isFinite(ms) && ms > 0) {
    telemetry.confirmMs.push(Math.floor(ms));
    if (telemetry.confirmMs.length > 200) telemetry.confirmMs.shift();
  }
}

export function getTxTelemetry() {
  const arr = telemetry.confirmMs.slice().sort((a, b) => a - b);
  const p = (q: number) => (arr.length ? arr[Math.min(arr.length - 1, Math.floor(q * (arr.length - 1)))] : 0);
  return {
    tx_sent: telemetry.sent,
    tx_confirmed: telemetry.confirmed,
    tx_failed: telemetry.failed,
    p50_ms: p(0.50),
    p95_ms: p(0.95),
  };
}

export async function withJitoBundleOrFallback(args: {
  connection: Connection;
  txs: (Transaction | VersionedTransaction)[];
  tipLamports?: number;
}): Promise<string[]> {
  // Placeholder: just send sequentially with small gaps, highest priority via compute budget if legacy tx
  const sigs: string[] = [];
  for (const t of args.txs) {
    if (t instanceof Transaction) {
      const result = await sendTxWithRetries({ connection: args.connection, tx: t, signers: [], skipPreflight: false }).catch(async (e) => {
        throw e;
      });
      sigs.push(result.signature);
    } else {
      const wire = t.serialize();
      const sig = await args.connection.sendRawTransaction(wire, { skipPreflight: false, maxRetries: 0 });
      const latest = await args.connection.getLatestBlockhash("processed");
      await args.connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
      sigs.push(sig);
    }
    await sleep(25);
  }
  return sigs;
}

