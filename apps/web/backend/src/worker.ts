export interface Env {
  /** Основной апстрим для Solana JSON-RPC */
  UPSTREAM_RPC_URL?: string;
  /** Поддержка старого имени, если уже создал */
  UPSTREAM_ON_URL?: string;

  /** Опционально: общий токен доступа */
  ACCESS_TOKEN?: string;

  /** База для проксирования Pump APIs (по умолчанию pumpportal.fun) */
  PUMP_BASE?: string; // например, https://pumpportal.fun
  /** Если у провайдера Pump есть API-ключ */
  PUMP_API_KEY?: string;

  /** Разрешённые origin'ы через запятую; по умолчанию '*' */
  CORS_ORIGINS?: string; // напр. "https://app.cryptolaunchbot.uk,https://solanamem1337.pages.dev"
}

const JSON_CT = "application/json; charset=utf-8";

/* ----------------------------- helpers ----------------------------- */

function pickRpcUrl(env: Env): string {
  const url = (env.UPSTREAM_RPC_URL || env.UPSTREAM_ON_URL || "").trim();
  if (!url) throw new Error("UPSTREAM_RPC_URL secret is not set");
  return url;
}

function allowedOrigin(req: Request, env: Env): string {
  const origin = req.headers.get("Origin") || "";
  const cfg = (env.CORS_ORIGINS || "*").trim();
  if (cfg === "*" || !cfg) return "*";
  const list = cfg.split(",").map((s) => s.trim()).filter(Boolean);
  if (list.includes(origin)) return origin;
  // если не совпало — вернём первый как дефолт (или '*', если список пуст)
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
  return withCors(
    req,
    env,
    new Response(JSON.stringify(body), { status, headers: { "content-type": JSON_CT } })
  );
}

function isAuthOk(req: Request, env: Env): boolean {
  const required = (env.ACCESS_TOKEN || "").trim();
  if (!required) return true; // токен не задан — доступ открыт

  const url = new URL(req.url);
  const q = url.searchParams.get("token");
  const bearer = (req.headers.get("authorization") || "").replace(/^Bearer\s+/i, "");
  const x = req.headers.get("x-api-key") || "";

  return q === required || bearer === required || x === required;
}

/* ----------------------------- route: /rpc ----------------------------- */

async function handleRpc(req: Request, env: Env): Promise<Response> {
  if (!isAuthOk(req, env)) {
    return json(req, env, 401, { error: "UNAUTHORIZED" });
  }

  const upstream = pickRpcUrl(env);

  // таймаут на всякий случай
  const ac = new AbortController();
  const to = setTimeout(() => ac.abort("timeout"), 15_000);

  try {
    const r = await fetch(upstream, {
      method: "POST",
      body: req.body, // потоковая передача
      headers: {
        "content-type": "application/json",
      },
      signal: ac.signal,
    });

    // просто пробрасываем ответ апстрима + CORS
    return withCors(req, env, r);
  } catch (e: any) {
    const msg = e?.message || String(e);
    return json(req, env, 500, { error: "UPSTREAM_FAIL", message: msg });
  } finally {
    clearTimeout(to);
  }
}

/* ----------------------------- route: /x/pump/* ----------------------------- */

function pumpBase(env: Env): string {
  return (env.PUMP_BASE || "https://pumpportal.fun").replace(/\/+$/, "");
}

async function handlePumpProxy(req: Request, env: Env, url: URL): Promise<Response> {
  // /x/pump/<...> -> PUMP_BASE/<...>
  const targetPath = url.pathname.replace(/^\/x\/pump/, "") || "/";
  const targetUrl = new URL(pumpBase(env) + targetPath);
  targetUrl.search = url.search; // проброс query

  const headers = new Headers(req.headers);
  // защита/чистка служебных заголовков
  headers.delete("host");
  headers.delete("cf-connecting-ip");
  headers.delete("x-forwarded-for");
  headers.delete("x-real-ip");

  if (env.PUMP_API_KEY) headers.set("x-api-key", env.PUMP_API_KEY);

  const init: RequestInit = {
    method: req.method,
    headers,
    body: req.body, // важен pass-through (включая бинарный /api/trade-local)
  };

  const r = await fetch(targetUrl.toString(), init);
  // пробрасываем как есть, только добавим CORS
  return withCors(req, env, r);
}

/* ----------------------------- fetch ----------------------------- */

export default {
  async fetch(req: Request, env: Env, _ctx: ExecutionContext): Promise<Response> {
    const url = new URL(req.url);

    // CORS preflight
    if (req.method === "OPTIONS") {
      return new Response(null, { headers: corsHeaders(req, env) });
    }

    // health
    if (req.method === "GET" && (url.pathname === "/rpc/health" || url.pathname === "/__health")) {
      return withCors(req, env, new Response("ok", { status: 200 }));
    }

    // RPC proxy
    if (req.method === "POST" && url.pathname === "/rpc") {
      return handleRpc(req, env);
    }

    // Pump proxy: /x/pump/*
    if (url.pathname.startsWith("/x/pump/") || url.pathname === "/x/pump") {
      return handlePumpProxy(req, env, url);
    }

    // корневая страница — короткая справка
    if (url.pathname === "/" && req.method === "GET") {
      const body = `rpc-proxy worker
- POST /rpc          -> JSON-RPC proxy (token via Authorization: Bearer / x-api-key / ?token=)
- GET  /rpc/health   -> health check
- *    /x/pump/*     -> proxy to PUMP_BASE (default https://pumpportal.fun)
`;
      return withCors(req, env, new Response(body, { status: 200, headers: { "content-type": "text/plain; charset=utf-8" } }));
    }

    return json(req, env, 404, { error: "NOT_FOUND" });
  },
} satisfies ExportedHandler<Env>;
