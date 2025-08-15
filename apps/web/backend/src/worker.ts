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
}

const JSON_CT = "application/json; charset=utf-8";

/* ----------------------------- helpers ----------------------------- */

function pickRpcHttp(env: Env): string {
  const url =
    env.UPSTREAM_RPC_URL ||
    env.UPSTREAM_ON_URL ||
    env.UPSTREAM_QN_URL ||
    "";
  if (!url.trim()) throw new Error("UPSTREAM_RPC_URL secret is not set");
  return url.trim();
}

function pickRpcWs(env: Env): string {
  const ws =
    env.UPSTREAM_RPC_WS ||
    env.UPSTREAM_QN_WS ||
    pickRpcHttp(env).replace(/^http/i, "ws");
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

/* ----------------------------- JSON-RPC (/rpc) ----------------------------- */

async function handleRpcHttp(req: Request, env: Env): Promise<Response> {
  if (!isAuthOk(req, env)) return json(req, env, 401, { error: "UNAUTHORIZED" });

  const upstream = pickRpcHttp(env);

  const ac = new AbortController();
  const to = setTimeout(() => ac.abort("timeout"), 15_000);

  try {
    const hdr = new Headers({ "content-type": "application/json" });
    if (env.QN_TOKEN) hdr.set("x-api-key", env.QN_TOKEN);

    const r = await fetch(upstream, { method: "POST", body: req.body, headers: hdr, signal: ac.signal });
    return withCors(req, env, r);
  } catch (e: any) {
    return json(req, env, 500, { error: "UPSTREAM_FAIL", message: e?.message || String(e) });
  } finally {
    clearTimeout(to);
  }
}

/* ----------------------------- Pump proxy (/x/pump/*) ----------------------------- */

async function handlePumpProxy(req: Request, env: Env, url: URL): Promise<Response> {
  const targetPath = url.pathname.replace(/^\/x\/pump/, "") || "/";
  const targetUrl = new URL(pumpBase(env) + targetPath);
  targetUrl.search = url.search;

  const headers = new Headers(req.headers);
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");
  if (env.PUMP_API_KEY) headers.set("x-api-key", env.PUMP_API_KEY);

  const r = await fetch(targetUrl.toString(), { method: req.method, headers, body: req.body });
  return withCors(req, env, r);
}

/* ----------------------------- fetch ----------------------------- */

export default {
  async fetch(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(req, env) });
    }

    // ⬇️ WebSocket upgrade для /rpc  (ВАЖНО для web3.js)
    if (req.headers.get("upgrade")?.toLowerCase() === "websocket" && url.pathname.startsWith("/rpc")) {
      // Проверка токена доступа — такая же, как и для HTTP
      if (!isAuthOk(req, env)) return new Response("Unauthorized", { status: 401 });

      const upWs = new URL(pickRpcWs(env));
      // путь оставляем «как есть» (у QN/Helius WS на корне '/')
      // если ваш апстрим ждёт токен в query, можно добавить тут:
      // if (env.QN_TOKEN) upWs.searchParams.set("api-key", env.QN_TOKEN);

      const wsHdr = new Headers(req.headers);
      if (env.QN_TOKEN) wsHdr.set("x-api-key", env.QN_TOKEN);

      // NB: создаём новый Request, чтобы можно было подменить заголовки
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

    // Pump proxy
    if (url.pathname.startsWith("/x/pump")) {
      return handlePumpProxy(req, env, url);
    }

    // Короткая справка
    if (url.pathname === "/" && req.method === "GET") {
      const body = `rpc-proxy worker
- POST /rpc        -> JSON-RPC proxy
- WS   /rpc        -> WebSocket proxy (signatureSubscribe, и т.п.)
- GET  /rpc/health -> health check
- *    /x/pump/*   -> proxy to PUMP_BASE (default https://pumpportal.fun)
`;
      return withCors(req, env, new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
    }

    return json(req, env, 404, { error: "NOT_FOUND" });
  },
} satisfies ExportedHandler<Env>;
