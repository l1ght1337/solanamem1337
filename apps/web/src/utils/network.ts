// apps/web/src/utils/network.ts
// Глобальный планировщик сетевых запросов: ограничение параллелизма и RPS,
// таймауты, небольшие метрики. Без внешних зависимостей.

type Job<T = Response> = {
  dueTime: number;
  fn: () => Promise<T>;
  resolve: (v: T) => void;
  reject: (e: any) => void;
  tag?: string;
};

class TokenBucket {
  private capacity: number;
  private ratePerSec: number;
  private tokens: number;
  private lastRefill: number;
  constructor(capacity: number, ratePerSec: number) {
    this.capacity = Math.max(1, capacity);
    this.ratePerSec = Math.max(1, ratePerSec);
    this.tokens = this.capacity;
    this.lastRefill = Date.now();
  }
  refill() {
    const now = Date.now();
    const delta = (now - this.lastRefill) / 1000;
    if (delta > 0) {
      this.tokens = Math.min(this.capacity, this.tokens + delta * this.ratePerSec);
      this.lastRefill = now;
    }
  }
  tryTake(n = 1): boolean {
    this.refill();
    if (this.tokens >= n) { this.tokens -= n; return true; }
    return false;
  }
}

export type ScheduleInit = RequestInit & {
  timeoutMs?: number;
  tries?: number;
  backoffBaseMs?: number; // по умолчанию 250ms экспоненциально
};

export type NetMetrics = {
  rps: number;        // за последний 1s интервал
  ok: number;
  err: number;
  inflight: number;
  queued: number;
  avgLatencyMs: number;
};

class Scheduler {
  private maxConcurrency: number;
  private bucket: TokenBucket;
  private inflight = 0;
  private queue: Job[] = [];
  private rpsCount = 0;
  private rpsTs = Math.floor(Date.now() / 1000);
  private ok = 0;
  private err = 0;
  private lat: number[] = [];

  constructor(maxConcurrency: number, maxRps: number) {
    this.maxConcurrency = Math.max(1, maxConcurrency);
    this.bucket = new TokenBucket(maxRps, maxRps);
    // RPS window ticker
    setInterval(() => this.tickRps(), 1000);
    // Периодически пробуем запускать задачи из очереди, чтобы не залипать,
    // когда токены появились позже (в фоне таймеры могут клампиться браузером)
    setInterval(() => this.maybeRun(), 100);
  }

  private tickRps() {
    const now = Math.floor(Date.now() / 1000);
    if (now !== this.rpsTs) {
      this.rpsTs = now;
      this.rpsCount = 0;
    }
  }

  private maybeRun() {
    // запускаем, пока есть ресурсы и задачи готовы по dueTime
    while (this.inflight < this.maxConcurrency && this.bucket.tryTake(1)) {
      const now = Date.now();
      let idx = this.queue.findIndex((j) => j.dueTime <= now);
      if (idx === -1) {
        // ближайшая задача ещё не готова
        break;
      }
      const [job] = this.queue.splice(idx, 1);
      this.runJob(job);
    }
    // Если токенов нет или достигнут предел — перезапустимся позже автоматически таймером
  }

  private runJob(job: Job) {
    this.inflight++;
    const started = Date.now();
    job.fn()
      .then((res) => {
        this.ok++;
        const ms = Date.now() - started;
        this.lat.push(ms);
        if (this.lat.length > 100) this.lat.shift();
        this.rpsCount++;
        job.resolve(res);
      })
      .catch((e) => {
        this.err++;
        job.reject(e);
      })
      .finally(() => {
        this.inflight = Math.max(0, this.inflight - 1);
        this.maybeRun();
      });
  }

  schedule(url: string, init: ScheduleInit = {}, tag?: string): Promise<Response> {
    const tries = Math.max(1, init.tries ?? 2);
    const timeoutMs = Math.max(1000, init.timeoutMs ?? 15000);
    const backoffBase = Math.max(50, init.backoffBaseMs ?? 250);
    const headers = new Headers(init.headers as any);

    const makeAttempt = (attempt: number): Promise<Response> => {
      const ac = new AbortController();
      const t = setTimeout(() => ac.abort(), timeoutMs);
      const started = Date.now();
      return fetch(url, { ...init, headers, signal: ac.signal })
        .then((r) => {
          clearTimeout(t);
          if (r.ok) return r;
          if (attempt + 1 < tries && (r.status === 429 || r.status >= 500)) {
            const jitter = Math.floor(Math.random() * 200);
            const delay = backoffBase * Math.pow(2, attempt) + jitter;
            return new Promise<Response>((resolve, reject) => {
              setTimeout(() => {
                makeAttempt(attempt + 1).then(resolve).catch(reject);
              }, delay);
            });
          }
          return r; // отдаём 4xx как есть
        })
        .catch((e) => {
          clearTimeout(t);
          if (attempt + 1 < tries) {
            const jitter = Math.floor(Math.random() * 200);
            const delay = backoffBase * Math.pow(2, attempt) + jitter;
            return new Promise<Response>((resolve, reject) => {
              setTimeout(() => {
                makeAttempt(attempt + 1).then(resolve).catch(reject);
              }, delay);
            });
          }
          throw e;
        })
        .finally(() => {
          // rps + latency учитываются на верхнем уровне
        });
    };

    return new Promise<Response>((resolve, reject) => {
      const job: Job = {
        dueTime: Date.now(),
        tag,
        fn: () => makeAttempt(0),
        resolve,
        reject,
      };
      this.queue.push(job);
      // Немедленный пинок очереди
      this.maybeRun();
    });
  }

  getMetrics(): NetMetrics {
    const avg = this.lat.length ? Math.round(this.lat.reduce((a, b) => a + b, 0) / this.lat.length) : 0;
    return {
      rps: this.rpsCount,
      ok: this.ok,
      err: this.err,
      inflight: this.inflight,
      queued: this.queue.length,
      avgLatencyMs: avg,
    };
  }
}

const MAX_PAR = Number((import.meta.env as any).VITE_NET_MAX_PAR ?? 12);
const MAX_RPS = Number((import.meta.env as any).VITE_NET_MAX_RPS ?? 180);
export const net = new Scheduler(MAX_PAR, MAX_RPS);

export function scheduleFetch(url: string, init?: ScheduleInit, tag?: string) {
  return net.schedule(url, init, tag);
}

export function getNetMetrics(): NetMetrics { return net.getMetrics(); }

