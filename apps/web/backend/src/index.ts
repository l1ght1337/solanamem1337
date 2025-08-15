import { Buffer } from 'buffer';
(globalThis as any).Buffer ||= Buffer;

export { BotManager } from './do/BotManager';

export default {
  async fetch(req: Request, env: Env, ctx: ExecutionContext) {
    const url = new URL(req.url);
    const originOk = (env.CORS_ORIGINS || '*');

    // CORS preflight
    if (req.method === 'OPTIONS') {
      return new Response('', {
        status: 204,
        headers: {
          'access-control-allow-origin': originOk.includes('*') ? '*' : url.origin,
          'access-control-allow-headers': 'authorization, content-type',
          'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
        }
      });
    }

    // /rpc — простой прокси к Solana RPC
    if (url.pathname === '/rpc') {
      const target = env.RPC_PRIMARY;
      const init: RequestInit = {
        method: req.method,
        headers: { 'content-type': 'application/json' },
        body: req.method === 'GET' ? undefined : await req.text(),
      };
      const r = await fetch(target, init);
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': r.headers.get('content-type') || 'application/json', 'access-control-allow-origin': '*' }
      });
    }

    // /x/pump/* → pumpportal
    if (url.pathname.startsWith('/x/pump')) {
      const base = env.PUMP_BASE || 'https://pumpportal.fun';
      const path = url.pathname.replace(/^\/x\/pump/, '');
      const r = await fetch(`${base}${path}${url.search}`, {
        method: req.method,
        headers: { 'content-type': req.headers.get('content-type') || 'application/json' },
        body: req.method === 'GET' ? undefined : await req.text()
      });
      return new Response(r.body, { status: r.status, headers: { 'content-type': r.headers.get('content-type') || 'application/json', 'access-control-allow-origin':'*' }});
    }

    // /api/* → Durable Object
    if (url.pathname.startsWith('/api/')) {
      const id = env.BOT_MANAGER.idFromName('global');
      const stub = env.BOT_MANAGER.get(id);
      const r = await stub.fetch(new Request(new URL(url.pathname, 'http://do.internal').toString(), {
        method: req.method,
        headers: req.headers,
        body: req.method === 'GET' ? undefined : await req.text()
      }));
      // пробрасываем CORS
      return new Response(r.body, {
        status: r.status,
        headers: { 'content-type': r.headers.get('content-type') || 'application/json', 'access-control-allow-origin':'*' }
      });
    }

    return new Response('ok', { status: 200, headers: { 'access-control-allow-origin': '*' }});
  }
};

export interface Env {
  ACCESS_TOKEN: string;
  MASTER_KEY: string;
  RPC_PRIMARY: string;
  RPC_FALLBACK?: string;
  PUMP_BASE?: string;
  CORS_ORIGINS?: string;
  BOT_MANAGER: DurableObjectNamespace;
}
