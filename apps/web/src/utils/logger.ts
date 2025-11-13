// apps/web/src/utils/logger.ts
export type LogLevel = "info" | "warn" | "error" | "ok" | "err";
export type LogEntry = { ts: string; level: LogLevel; msg: string };

type Subscriber = (entry: LogEntry) => void;

class RingLogger {
  private buffer: LogEntry[] = [];
  private subs: Set<Subscriber> = new Set();
  private cap: number;

  constructor(capacity = 500) {
    this.cap = Math.max(50, capacity);
  }

  subscribe(fn: Subscriber): () => void {
    this.subs.add(fn);
    return () => { try { this.subs.delete(fn); } catch {} };
  }

  private push(level: LogLevel, msg: string) {
    const entry: LogEntry = { ts: new Date().toLocaleTimeString(), level, msg: String(msg) };
    // console mirror
    try {
      if (level === "error" || level === "err") console.error(msg);
      else if (level === "warn") console.warn(msg);
      else console.log(msg);
    } catch {}
    // ring buffer
    this.buffer.push(entry);
    if (this.buffer.length > this.cap) this.buffer.splice(0, this.buffer.length - this.cap);
    // notify
    for (const s of Array.from(this.subs)) {
      try { s(entry); } catch {}
    }
  }

  info(msg: string) { this.push("info", msg); }
  warn(msg: string) { this.push("warn", msg); }
  error(msg: string) { this.push("error", msg); }
  ok(msg: string) { this.push("ok", msg); }
  err(msg: string) { this.push("err", msg); }

  snapshot(): LogEntry[] { return this.buffer.slice(); }
}

export const logger = new RingLogger(500);
