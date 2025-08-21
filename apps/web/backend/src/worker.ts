// apps/web/backend/src/worker.ts

export interface Env {
  /** HTTP апстрим JSON-RPC (QuickNode/Helius/own) */
  UPSTREAM_RPC_URL?: string;
  /** legacy совместимость */
  UPSTREAM_ON_URL?: string;
  UPSTREAM_QN_URL?: string;

  /** НЕ обязательно: явный WS апстрим; если не задан — берём UPSTREAM_RPC_URL с http->ws */
  UPSTREAM_RPC_WS?: string;
  UPSTREAM_QN_WS?: string;

  /** (опц.) если апстриму нужен API-ключ (напр., QuickNode) — добавим в заголовок */
  QN_TOKEN?: string;

  /** (опц.) защита воркера: токен доступа, который должен прислать клиент */
  ACCESS_TOKEN?: string;

  /** Проксирование Pump APIs */
  PUMP_BASE?: string;          // default https://pumpportal.fun
  PUMP_API_KEY?: string;

  /** CORS (через запятую) — по умолчанию * */
  CORS_ORIGINS?: string;

  /** (опц.) лимиты воркера */
  RATE_MAX_CONCURRENCY?: string; // например 16
  RATE_MAX_RPS?: string;         // например 120
}

const JSON_CT = "application/json; charset=utf-8";

/* ----------------------------- rate limiting & metrics ----------------------------- */

// Простая реализация TokenBucket + семафор в памяти воркера.
// Работает в одном изоляте; для прод — держите несколько воркеров (как у вас 01/02/03).

class TokenBucket {
  private capacity: number;
  private ratePerSec: number;
  private tokens: number;
  private lastRefill: number;
  private waiters: Array<() => void> = [];

  constructor(capacity: number, ratePerSec: number) {
    this.capacity = Math.max(1, capacity);
    this.ratePerSec = Math.max(1, ratePerSec);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }

  private refill() {
    const now = Date.now();
    const delta = (now - this.lastRefill) / 1000;
    if (delta <= 0) return;
    this.lastRefill = now;
    this.tokens = Math.min(this.capacity, this.tokens + delta * this.ratePerSec);
  }

  async acquire(n = 1): Promise<void> {
    while (true) {
      this.refill();
      if (this.tokens >= n) {
        this.tokens -= n;
        return;
      }
      await new Promise<void>((res) => this.waiters.push(res));
    }
  }

  notify() {
    // будим одного ожидателя на каждый токен
    this.refill();
    while (this.tokens >= 1 && this.waiters.length) {
      this.tokens -= 1;
      const w = this.waiters.shift();
      try { w && w(); } catch {}
    }
  }
}

class Semaphore {
  private max: number;
  private inuse = 0;
  private queue: Array<() => void> = [];
  constructor(max: number) { this.max = Math.max(1, max); }
  async acquire(): Promise<void> {
    if (this.inuse < this.max) { this.inuse++; return; }
    await new Promise<void>((res) => this.queue.push(res));
    this.inuse++;
  }
  release() {
    this.inuse = Math.max(0, this.inuse - 1);
    const next = this.queue.shift();
    if (next) next();
  }
  getInUse() { return this.inuse; }
  getQueueLen() { return this.queue.length; }
}

let bucket = new TokenBucket(120, 120);
let sem = new Semaphore(16);
function ensureLimits(env: Env) {
  const maxConc = Number(env.RATE_MAX_CONCURRENCY || 16);
  const maxRps = Number(env.RATE_MAX_RPS || 120);
  const g: any = globalThis as any;
  const key = `${maxConc}|${maxRps}`;
  if (g.__limKey !== key) {
    g.__limKey = key;
    bucket = new TokenBucket(maxRps, maxRps);
    sem = new Semaphore(maxConc);
  }
}

const metrics = {
  started: Date.now(),
  inflight: 0,
  queued: () => sem.getQueueLen(),
  ok: 0,
  err: 0,
  lastSecCount: 0,
  lastSecTs: Math.floor(Date.now() / 1000),
  latencies: [] as number[], // последние ~100
};

function upstreamFetch(env: Env, url: string, init: RequestInit & { timeoutMs?: number; tries?: number } = {}) {
  ensureLimits(env);
  const tries = Math.max(1, Number(init.tries ?? 3));
  const timeoutMs = Math.max(1000, Number(init.timeoutMs ?? 15000));
  let lastErr: any;
  for (let i = 0; i < tries; i++) {
    const backoff = i === 0 ? 0 : Math.min(5000, 250 * Math.pow(2, i - 1)) + Math.floor(Math.random() * 200);
    if (backoff) await new Promise((r) => setTimeout(r, backoff));

    await bucket.acquire(1);
    await sem.acquire();
    metrics.inflight++;
    const started = Date.now();
    const ac = new AbortController();
    const to = setTimeout(() => ac.abort(), timeoutMs);
    try {
      const r = await fetch(url, { ...init, signal: ac.signal });
      clearTimeout(to);
      const ms = Date.now() - started;
      recordLatency(ms);
      metrics.lastSecCount++;
      if (r.ok) { metrics.ok++; return r; }
      if (r.status === 429 || r.status >= 500) { lastErr = new Error(`${r.status}`); continue; }
      return r; // пусть 4xx пройдут как есть
    } catch (e) {
      lastErr = e;
    } finally {
      metrics.inflight = Math.max(0, metrics.inflight - 1);
      sem.release();
      bucket.notify();
    }
  }
  throw lastErr || new Error("upstream failed");
}

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    ensureLimits(env);
    const url = new URL(req.url);
    const method = req.method;
    const headers = req.headers;
    const body = req.body;

    const upstreamUrl = url.searchParams.get("upstream_url");
    if (!upstreamUrl) {
      return new Response("upstream_url parameter is required", { status: 400 });
    }

    const init: RequestInit = {
      method: method,
      headers: headers,
      body: body,
    };

    try {
      const response = await upstreamFetch(env, upstreamUrl, init);
      return new Response(JSON.stringify(response), { status: response.status, headers: Object.fromEntries(response.headers.entries()) });
    } catch (e) {
      console.error("Upstream fetch failed:", e);
      return new Response(JSON.stringify({ error: e.message }), { status: 500 });
    }
  },
} satisfies ExportedHandler<Env>;