import { Connection, Commitment } from "@solana/web3.js";

type RpcStats = {
  url: string;
  sendFail: number;
  sendOk: number;
  p95ConfirmMs: number;
  confirmSamples: number[];
  lastError?: string;
};

const DEFAULT_COMMITMENT: Commitment = "confirmed";

export type RpcEndpoint = { url: string; name: string };

export function makeSmartConnection(url: string): Connection {
  return new Connection(url, { commitment: DEFAULT_COMMITMENT });
}

// compat alias with spec
export function makeConnection(url: string): Connection {
  return makeSmartConnection(url);
}

function percentile(arr: number[], p: number): number {
  if (!arr.length) return 0;
  const sorted = arr.slice().sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.floor((sorted.length - 1) * p));
  return sorted[idx];
}

const env = (import.meta as any).env || {};
const PRIMARY = String(env.VITE_SOLANA_RPC_PRIMARY || env.VITE_RPC_PRIMARY || "").trim();
const FALLBACKS: string[] = [
  env.VITE_SOLANA_RPC_FALLBACK_1 || env.VITE_RPC_FALLBACK || "",
  env.VITE_SOLANA_RPC_FALLBACK_2 || "",
].map((s: string) => String(s || "").trim()).filter(Boolean);

const FAIL_RATE_THR = Math.max(0, Number(env.VITE_RPC_FAIL_RATE_THRESHOLD ?? 0.15));
const P95_CONFIRM_THR = Math.max(0, Number(env.VITE_RPC_P95_CONFIRM_MS ?? 2500));

let activeIdx = 0; // 0 => primary, >0 => fallbacks
let conns: Connection[] = [];
let stats: RpcStats[] = [];

function buildAll() {
  const urls = [PRIMARY, ...FALLBACKS].filter(Boolean);
  if (!urls.length) return;
  conns = urls.map((u) => makeSmartConnection(u));
  stats = urls.map((u) => ({ url: u, sendFail: 0, sendOk: 0, p95ConfirmMs: 0, confirmSamples: [], lastError: undefined }));
}

buildAll();

export function getActiveConnection(): Connection | undefined {
  return conns[activeIdx];
}

export function getActiveRpcUrl(): string {
  return stats[activeIdx]?.url || "";
}

export function getRpcTelemetry() {
  const s = stats[activeIdx];
  const total = (s?.sendOk || 0) + (s?.sendFail || 0);
  const failRate = total ? (s!.sendFail / total) : 0;
  return {
    url: s?.url || "",
    failRate,
    p95ConfirmMs: s?.p95ConfirmMs || 0,
    lastError: s?.lastError || "",
  };
}

export function noteRpcSend(ok: boolean) {
  const s = stats[activeIdx];
  if (!s) return;
  if (ok) s.sendOk++; else s.sendFail++;
}

export function noteRpcConfirm(ms: number) {
  const s = stats[activeIdx];
  if (!s) return;
  if (Number.isFinite(ms) && ms > 0) {
    s.confirmSamples.push(Math.floor(ms));
    if (s.confirmSamples.length > 200) s.confirmSamples.shift();
    s.p95ConfirmMs = percentile(s.confirmSamples, 0.95);
  }
}

function shouldFailover(): boolean {
  const s = stats[activeIdx];
  if (!s) return false;
  const total = s.sendOk + s.sendFail;
  const failRate = total ? s.sendFail / total : 0;
  return failRate > FAIL_RATE_THR || s.p95ConfirmMs > P95_CONFIRM_THR;
}

export function tryFailover(): boolean {
  if (conns.length <= 1) return false;
  if (!shouldFailover()) return false;
  const prev = activeIdx;
  activeIdx = (activeIdx + 1) % conns.length;
  console.warn(`[RPC] failover ${stats[prev]?.url} -> ${stats[activeIdx]?.url}`);
  return true;
}

// Optional helpers to wrap sends and record metrics; use only for telemetry, not to change Connection API
export async function sendAndConfirmWithStats(connection: Connection, wire: Uint8Array): Promise<string> {
  const started = Date.now();
  try {
    const sig = await connection.sendRawTransaction(wire, { skipPreflight: true, maxRetries: 0 });
    const latest = await connection.getLatestBlockhash("processed");
    const res = await connection.confirmTransaction({ signature: sig, ...latest }, "confirmed");
    if (res.value.err) throw new Error(JSON.stringify(res.value.err));
    noteRpcSend(true);
    noteRpcConfirm(Date.now() - started);
    return sig;
  } catch (e: any) {
    noteRpcSend(false);
    stats[activeIdx].lastError = e?.message || String(e);
    throw e;
  }
}

// Health ping; switch if degraded
export async function healthcheckAndMaybeFailover(): Promise<void> {
  const c = getActiveConnection();
  if (!c) return;
  try {
    const t0 = Date.now();
    await c.getSlot("processed");
    noteRpcConfirm(Date.now() - t0);
    if (shouldFailover()) tryFailover();
  } catch (e: any) {
    stats[activeIdx].lastError = e?.message || String(e);
    tryFailover();
  }
}

// Try endpoints one by one with a 1500ms timeout and simple RPC calls
export async function pickHealthy(rpcs: RpcEndpoint[]): Promise<{ connection: Connection; endpoint: RpcEndpoint } | null> {
  const list = (rpcs || []).filter((r) => r && r.url).slice();
  for (const ep of list) {
    const conn = makeConnection(ep.url);
    const ok = await (async () => {
      const ac = new AbortController();
      const to = setTimeout(() => ac.abort(), 1500);
      try {
        // run a couple of cheap calls sequentially to avoid rate spikes
        await conn.getLatestBlockhash("processed");
        await conn.getSlot("processed");
        clearTimeout(to);
        return true;
      } catch {
        clearTimeout(to);
        return false;
      }
    })();
    if (ok) return { connection: conn, endpoint: ep };
  }
  return null;
}

