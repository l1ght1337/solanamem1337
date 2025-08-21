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
			if (this.tokens >= n) { this.tokens -= n; return; }
			await new Promise<void>((res) => this.waiters.push(res));
		}
	}
	notify() {
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
	latencies: [] as number[],
};

function recordLatency(ms: number) {
	metrics.latencies.push(ms);
	if (metrics.latencies.length > 100) metrics.latencies.shift();
}

/* ----------------------------- helpers ----------------------------- */

function pickRpcHttp(env: Env): string {
	const url = env.UPSTREAM_RPC_URL || env.UPSTREAM_ON_URL || env.UPSTREAM_QN_URL || "";
	if (!url.trim()) throw new Error("UPSTREAM_RPC_URL secret is not set");
	return url.trim();
}

function pickRpcWs(env: Env): string {
	const ws = env.UPSTREAM_RPC_WS || env.UPSTREAM_QN_WS || pickRpcHttp(env).replace(/^http/i, "ws");
	return ws.trim();
}

function allowedOrigin(req: Request, env: Env): string {
	const origin = req.headers.get("Origin") || "";
	const cfg = (env.CORS_ORIGINS || "*").trim();
	if (cfg === "*" || !cfg) return "*";
	const list = cfg.split(",").map((s) => s.trim()).filter(Boolean);
	if (list.includes(origin)) return origin;
	return list[0] || "*";
}

function corsHeaders(req: Request, env: Env): Record<string, string> {
	const allowOrigin = allowedOrigin(req, env);
	const reqHdr = req.headers.get("Access-Control-Request-Headers") || "*";
	return {
		"Access-Control-Allow-Origin": allowOrigin,
		"Access-Control-Allow-Methods": "GET,POST,OPTIONS",
		"Access-Control-Allow-Headers": reqHdr,
		"Access-Control-Allow-Credentials": "true",
		Vary: "Origin",
	};
}

function withCors(req: Request, env: Env, res: Response): Response {
	const h = new Headers(res.headers);
	for (const [k, v] of Object.entries(corsHeaders(req, env))) h.set(k, v);
	return new Response(res.body, { status: res.status, statusText: res.statusText, headers: h });
}

function json(req: Request, env: Env, status: number, body: unknown) {
	return withCors(req, env, new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_CT } }));
}

function isAuthOk(req: Request, env: Env): boolean {
	const required = (env.ACCESS_TOKEN || "").trim();
	if (!required) return true;
	const url = new URL(req.url);
	const q = url.searchParams.get("token");
	const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
	const x = req.headers.get("x-api-key") || "";
	return q === required || bearer === required || x === required;
}

function pumpBase(env: Env): string {
	return (env.PUMP_BASE || "https://pumpportal.fun").replace(/\/+$/, "");
}

async function upstreamFetch(env: Env, url: string, init: RequestInit & { timeoutMs?: number; tries?: number } = {}) {
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
			return r;
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

setInterval?.(() => {
	const nowSec = Math.floor(Date.now() / 1000);
	if (nowSec !== metrics.lastSecTs) { metrics.lastSecTs = nowSec; metrics.lastSecCount = 0; }
}, 1000);

/* ----------------------------- simple RPC coalescer ----------------------------- */

type RpcReq = { jsonrpc: string; id: any; method: string; params?: any[] };

type PendingGet = { resolve: (v: Response) => void; reject: (e: any) => void; body: RpcReq };

const coalesce = {
	getAccountInfo: new Map<string, PendingGet[]>(),
	getBalance: new Map<string, PendingGet[]>(),
	timer: undefined as any,
	schedule(env: Env, upstream: string) {
		if (coalesce.timer) return;
		coalesce.timer = setTimeout(async () => {
			const flushOne = async (key: string, list: PendingGet[], kind: "getAccountInfo" | "getBalance") => {
				try {
					const pubkeys = list.map((p) => p.body.params?.[0]);
					const options = list[0]?.body.params?.[1] || {};
					const batchReq: RpcReq = { jsonrpc: "2.0", id: 1, method: "getMultipleAccounts", params: [pubkeys, options] };
					const r = await upstreamFetch(env, upstream, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(batchReq) });
					const j = await r.json().catch(() => null);
					const results = (j?.result?.value || []) as any[];
					for (let i = 0; i < list.length; i++) {
						const item = list[i];
						const resBody = kind === "getBalance"
							? { jsonrpc: "2.0", id: item.body.id, result: { value: Number(results[i]?.lamports ?? 0) } }
							: { jsonrpc: "2.0", id: item.body.id, result: results[i] ?? null };
						item.resolve(new Response(JSON.stringify(resBody), { status: 200, headers: { "content-type": JSON_CT } }));
					}
				} catch (e) {
					for (const item of list) item.reject(e);
				}
			};

			const up = (env as any).__rpcUpstream as string;
			const m1 = coalesce.getAccountInfo;
			const m2 = coalesce.getBalance;
			coalesce.timer = undefined;
			coalesce.getAccountInfo = new Map();
			coalesce.getBalance = new Map();
			await Promise.all([
				...[...m1.entries()].map(([k, v]) => flushOne(k, v, "getAccountInfo")),
				...[...m2.entries()].map(([k, v]) => flushOne(k, v, "getBalance")),
			]);
		}, 12);
	},
};

/* ----------------------------- JSON-RPC (/rpc) ----------------------------- */

async function handleRpcHttp(req: Request, env: Env): Promise<Response> {
	if (!isAuthOk(req, env)) return json(req, env, 401, { error: "UNAUTHORIZED" });
	const upstream = pickRpcHttp(env);
	(env as any).__rpcUpstream = upstream;
	const ac = new AbortController();
	const to = setTimeout(() => ac.abort("timeout"), 20_000);
	try {
		const hdr = new Headers({ "content-type": "application/json" });
		if (env.QN_TOKEN) hdr.set("x-api-key", env.QN_TOKEN);
		const raw = await req.text();
		let parsed: any; try { parsed = JSON.parse(raw); } catch {}
		const tryCoalesce = (call: RpcReq): Promise<Response> | null => {
			if (!call || typeof call !== "object") return null;
			const method = call.method;
			if (method !== "getAccountInfo" && method !== "getBalance") return null;
			const params = Array.isArray(call.params) ? call.params : [];
			const keyParts = [String(params?.[1]?.commitment || "processed"), String(params?.[1]?.encoding || "base64"), method];
			const map = method === "getAccountInfo" ? coalesce.getAccountInfo : coalesce.getBalance;
			const key = keyParts.join("|");
			return new Promise<Response>((resolve, reject) => {
				const arr = map.get(key) || [];
				arr.push({ resolve, reject, body: call });
				map.set(key, arr);
				coalesce.schedule(env, upstream);
			});
		};
		if (Array.isArray(parsed)) {
			const r = await upstreamFetch(env, upstream, { method: "POST", headers: hdr, body: raw, timeoutMs: 20000, tries: 3, signal: ac.signal as any });
			return withCors(req, env, r);
		}
		const maybe = tryCoalesce(parsed);
		if (maybe) { const r = await maybe; return withCors(req, env, r); }
		const r = await upstreamFetch(env, upstream, { method: "POST", headers: hdr, body: raw, timeoutMs: 20000, tries: 3, signal: ac.signal as any });
		return withCors(req, env, r);
	} catch (e: any) {
		return json(req, env, 500, { error: "UPSTREAM_FAIL", message: e?.message || String(e) });
	} finally { clearTimeout(to); }
}

/* ----------------------------- Pump proxy (/x/pump/*) ----------------------------- */

async function handlePumpProxy(req: Request, env: Env, url: URL): Promise<Response> {
	const targetPath = url.pathname.replace(/^\/x\/pump/, "") || "/";
	const targetUrl = new URL(pumpBase(env) + targetPath);
	targetUrl.search = url.search;
	const headers = new Headers(req.headers);
	headers.delete("host"); headers.delete("cf-connecting-ip"); headers.delete("x-forwarded-for"); headers.delete("x-real-ip");
	if (env.PUMP_API_KEY) headers.set("x-api-key", env.PUMP_API_KEY);
	const r = await upstreamFetch(env, targetUrl.toString(), { method: req.method, headers, body: req.body as any, timeoutMs: 20000, tries: 3 });
	return withCors(req, env, r);
}

/* ----------------------------- fetch ----------------------------- */

export default {
	async fetch(req: Request, env: Env): Promise<Response> {
		ensureLimits(env);
		const url = new URL(req.url);

		// CORS preflight
		if (req.method === "OPTIONS") {
			return new Response(null, { headers: corsHeaders(req, env) });
		}

		// WebSocket upgrade для /rpc
		if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname.startsWith("/rpc")) {
			if (!isAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });
			const upWs = new URL(pickRpcWs(env));
			const wsHdr = new Headers(req.headers);
			if (env.QN_TOKEN) wsHdr.set("x-api-key", env.QN_TOKEN);
			return fetch(upWs.toString(), new Request(req, { headers: wsHdr }));
		}

		// health
		if (req.method === "GET" && (url.pathname === "/rpc/health" || url.pathname === "/__health")) {
			return withCors(req, env, new Response("ok", { status: 200 }));
		}

		// RPC HTTP
		if (req.method === "POST" && url.pathname === "/rpc") {
			return handleRpcHttp(req, env);
		}

		// Jupiter proxy — ДОЛЖЕН идти до общего /x/pump, т.к. путь начинается с /x/pump/jup
		if (url.pathname.startsWith("/jup/") || url.pathname.startsWith("/x/pump/jup/")) {
			const JUP_BASE = "https://quote-api.jup.ag";
			const rel = url.pathname.replace(/^\/x\/pump\/jup/, "/jup");
			const after = rel.replace(/^\/jup/, "");
			const upstreamPath = after.startsWith("/v") ? after : `/v6${after || ""}`;
			const target = new URL(upstreamPath + url.search, JUP_BASE);
			const isPost = req.method === "POST";
			const rawBody = isPost ? await req.text() : undefined;
			const r = await upstreamFetch(env, target.toString(), {
				method: isPost ? "POST" : "GET",
				headers: { accept: "application/json", ...(isPost ? { "content-type": "application/json" } : {}) },
				body: rawBody,
				timeoutMs: 15000,
				tries: 3,
			});
			return withCors(req, env, r);
		}

		// Pump proxy (после спец-маршрутов)
		if (url.pathname.startsWith("/x/pump")) {
			return handlePumpProxy(req, env, url);
		}

		// index
		if (url.pathname === "/" && req.method === "GET") {
			const body = `rpc-proxy worker
- POST /rpc        -> JSON-RPC proxy
- WS   /rpc        -> WebSocket proxy (signatureSubscribe, и т.п.)
- GET  /rpc/health -> health check
- *    /x/pump/*   -> proxy to PUMP_BASE (default https://pumpportal.fun)
- *    /jup/*      -> proxy to https://quote-api.jup.ag (v6)
- GET  /__metrics  -> in-memory metrics
`;
			return withCors(req, env, new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
		}

		// metrics
		if (url.pathname === "/__metrics" && req.method === "GET") {
			const avg = metrics.latencies.length ? Math.round(metrics.latencies.reduce((a, b) => a + b, 0) / metrics.latencies.length) : 0;
			const body = {
				uptimeSec: Math.round((Date.now() - metrics.started) / 1000),
				inflight: metrics.inflight,
				queued: metrics.queued(),
				ok: metrics.ok,
				err: metrics.err,
				rpsWindowSec: 1,
				rps: metrics.lastSecCount,
				avgLatencyMs: avg,
				concurrencyInUse: sem.getInUse(),
			};
			return withCors(req, env, new Response(JSON.stringify(body), { status: 200, headers: { "content-type": JSON_CT } }));
		}

		return json(req, env, 404, { error: "NOT_FOUND" });
	},
} satisfies ExportedHandler<Env>;