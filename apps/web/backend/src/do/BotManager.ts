import { DurableObject } from 'cloudflare:workers';
import { Keypair, PublicKey } from '@solana/web3.js';
import { decryptAesGcm, encryptAesGcm, importMasterKey } from '../lib/crypto';
import { serverTrade } from '../lib/pump';
import type { BotConfig, BotStatus } from '../types';
import { Buffer } from 'buffer';
(globalThis as any).Buffer ||= Buffer;

type Stored = {
  bots: Record<string, BotConfig>;
  runtime: Record<string, BotStatus>;
  nextTickAt?: number; // timestamp для alarm()
  price: Record<string, { last: number; prev: number; ts: number }>; // по mint
};

export class BotManager extends DurableObject<Env> {
  state: DurableObjectState;
  env: Env;
  cache: Stored;

  constructor(state: DurableObjectState, env: Env) {
    super(state, env);
    this.state = state;
    this.env = env;
    this.cache = { bots: {}, runtime: {}, price: {} };
  }

  async load() {
    if (Object.keys(this.cache.bots).length) return;
    const data = await this.state.storage.get<Stored>('state');
    if (data) this.cache = data;
    this.cache.bots ||= {};
    this.cache.runtime ||= {};
    this.cache.price ||= {};
  }
  async save() { await this.state.storage.put('state', this.cache); }

  // ---------- утилиты ----------
  private async requireAuth(req: Request) {
    const hdr = req.headers.get('authorization') || '';
    const token = hdr.startsWith('Bearer ') ? hdr.slice(7) : '';
    if (!token || token !== this.env.ACCESS_TOKEN) {
      return new Response('Unauthorized', { status: 401 });
    }
    return null;
  }

  private async getKeypair(encBlob: string) {
    const master = await importMasterKey(this.env.MASTER_KEY);
    const plainB64 = await decryptAesGcm(master, encBlob);  // base64(secretKey)
    const raw = Uint8Array.from(atob(plainB64), c => c.charCodeAt(0));
    return Keypair.fromSecretKey(raw);
  }

  private async fetchPrice(mint: string): Promise<number | undefined> {
    // лёгкий источник — Dexscreener
    const u = `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`;
    try {
      const r = await fetch(u);
      if (!r.ok) return;
      const j = await r.json() as any;
      const p = Number(j?.pairs?.[0]?.priceUsd);
      if (!Number.isFinite(p)) return;
      const now = Date.now();
      const slot = Math.floor(now/60000)*60000;
      const m = this.cache.price[mint] || { last: p, prev: p, ts: slot };
      if (m.ts !== slot) { m.prev = m.last; m.last = p; m.ts = slot; } else { m.last = p; }
      this.cache.price[mint] = m;
      return p;
    } catch { return; }
  }

  private change1m(mint: string) {
    const m = this.cache.price[mint];
    if (!m) return 0;
    const a = m.prev || m.last, b = m.last || a;
    if (!a) return 0;
    return (b - a) / a;
  }

  private decide(strategy: string, price: number, change1m: number, budgetSol: number) {
    if (strategy === 'revert') return change1m > 0 ? { side:'sell', sizeSol:budgetSol } : { side:'buy', sizeSol:budgetSol };
    if (strategy === 'scalper') return Math.random()<0.5 ? { side:'buy', sizeSol:budgetSol/2 } : { side:'sell', sizeSol:budgetSol/2 };
    // trend
    return change1m >= 0 ? { side:'buy', sizeSol:budgetSol } : { side:'sell', sizeSol:budgetSol };
  }

  private scheduleNext() {
    const bots = Object.values(this.cache.bots).filter(b => b.running);
    if (bots.length === 0) return this.state.storage.deleteAlarm();
    const now = Date.now();
    const minGap = Math.min(...bots.map(b => b.speedMs));
    const at = now + Math.max(500, minGap);
    this.cache.nextTickAt = at;
    return this.state.storage.setAlarm(new Date(at));
  }

  // ---------- HTTP API ----------
  async fetch(req: Request) {
    await this.load();
    // CORS внутри DO
    if (req.method === 'OPTIONS') return this.cors(new Response('', { status: 204 }));

    const unauthorized = await this.requireAuth(req);
    if (unauthorized) return this.cors(unauthorized);

    const url = new URL(req.url);
    const path = url.pathname.replace(/^\/api/, '');

    try {
      if (req.method === 'GET' && path === '/bots') {
        const list = Object.values(this.cache.bots).map(b => {
          const rt = this.cache.runtime[b.id];
          return { ...rt, id: b.id, name: b.name, pubkey: b.pubkey, running: b.running, price: this.cache.price[b.mint]?.last };
        });
        return this.cors(json({ ok:true, data:list }));
      }

      if (req.method === 'POST' && path === '/bots') {
        const body = await req.json() as Partial<BotConfig> & { secretB64?: string };
        if (!body?.mint) throw new Error('mint required');

        // генерим или импортируем ключ
        let kp: Keypair;
        if (body.secretB64) {
          const bytes = Uint8Array.from(atob(body.secretB64), c=>c.charCodeAt(0));
          kp = Keypair.fromSecretKey(bytes);
        } else {
          kp = Keypair.generate();
        }
        const encKey = await encryptAesGcm(await importMasterKey(this.env.MASTER_KEY), btoa(String.fromCharCode(...kp.secretKey)));

        const id = crypto.randomUUID();
        const bot: BotConfig = {
          id,
          name: body.name || `Bot#${Object.keys(this.cache.bots).length+1}`,
          pubkey: kp.publicKey.toBase58(),
          secretEnc: encKey,
          running: false,
          speedMs: body.speedMs || 8000,
          budgetSol: body.budgetSol || 0.02,
          strategy: (body.strategy as any) || 'trend',
          slippageBps: body.slippageBps ?? 50,
          mint: body.mint,
          twap: body.twap || null
        };
        this.cache.bots[id] = bot;
        this.cache.runtime[id] = { id, name: bot.name, pubkey: bot.pubkey, running:false, fills:0, realized:0, unrealized:0, posToken:0, avgSol:0 };
        await this.save();
        return this.cors(json({ ok:true, data: bot }));
      }

      if (req.method === 'POST' && /^\/bots\/[^/]+\/start$/.test(path)) {
        const id = path.split('/')[2];
        const b = this.cache.bots[id]; if (!b) throw new Error('not found');
        b.running = true;
        this.cache.runtime[id].running = true;
        await this.save();
        await this.scheduleNext();
        return this.cors(json({ ok:true, data:true }));
      }

      if (req.method === 'POST' && /^\/bots\/[^/]+\/stop$/.test(path)) {
        const id = path.split('/')[2];
        const b = this.cache.bots[id]; if (!b) throw new Error('not found');
        b.running = false;
        this.cache.runtime[id].running = false;
        await this.save();
        await this.scheduleNext();
        return this.cors(json({ ok:true, data:true }));
      }

      if (req.method === 'DELETE' && /^\/bots\/[^/]+$/.test(path)) {
        const id = path.split('/')[2];
        delete this.cache.bots[id];
        delete this.cache.runtime[id];
        await this.save();
        await this.scheduleNext();
        return this.cors(json({ ok:true, data:true }));
      }

      if (req.method === 'GET' && path === '/status') {
        return this.cors(json({ ok:true, data:{ bots: Object.keys(this.cache.bots).length, nextTickAt: this.cache.nextTickAt||null }}));
      }

      return this.cors(json({ ok:false, error:'not_found' }, 404));
    } catch (e: any) {
      return this.cors(json({ ok:false, error: e?.message || String(e) }, 500));
    }
  }

  // ---------- Alarm: выполняем шаги ботов ----------
  async alarm() {
    await this.load();
    const bots = Object.values(this.cache.bots).filter(b => b.running);
    if (bots.length === 0) return;

    const now = Date.now();

    for (const b of bots) {
      try {
        // 1) цена + изменение
        const price = await this.fetchPrice(b.mint);
        const ch = this.change1m(b.mint);

        // 2) решение + (опц) TWAP
        if (!price) continue;
        const dec = this.decide(b.strategy, price, ch, b.budgetSol);

        const slices = b.twap?.slices && b.twap.slices > 1 ? b.twap.slices : 1;
        const gapMs = b.twap?.gapMs || 0;
        for (let i=0;i<slices;i++) {
          const wallet = await this.getKeypair(b.secretEnc);
          const sig = await serverTrade({
            rpcPrimary: this.env.RPC_PRIMARY,
            rpcFallback: this.env.RPC_FALLBACK,
            pumpBase: this.env.PUMP_BASE || 'https://pumpportal.fun',
            wallet,
            action: dec.side as 'buy'|'sell',
            mint: b.mint,
            amountSolUi: (dec.sizeSol || b.budgetSol)/slices,
            slippageBps: b.slippageBps
          });
          const rt = this.cache.runtime[b.id];
          rt.fills += 1;
          rt.last = `${dec.side} ${(dec.sizeSol/slices).toFixed(6)} SOL @ ${price.toFixed(9)} (${sig.slice(0,8)}…)`;
          rt.lastError = undefined;
          // PnL-учёт минимальный (как у фронта)
          const qty = (dec.sizeSol/slices) / price;
          if (dec.side === 'buy') {
            const newPos = rt.posToken + qty;
            rt.avgSol = newPos > 0 ? (rt.avgSol * rt.posToken + (dec.sizeSol/slices)) / newPos : price;
            rt.posToken = newPos;
          } else {
            const sellQty = Math.min(rt.posToken, qty);
            rt.posToken = Math.max(0, rt.posToken - sellQty);
            rt.realized += (price - rt.avgSol) * sellQty;
            if (rt.posToken === 0) rt.avgSol = 0;
          }
          rt.unrealized = rt.posToken * (price - (rt.avgSol || price));

          if (i < slices-1 && gapMs > 0) await new Promise(r => setTimeout(r, gapMs));
        }
      } catch (e:any) {
        const rt = this.cache.runtime[b.id];
        rt.lastError = e?.message || String(e);
      }
    }

    await this.save();
    await this.scheduleNext();
  }

  private cors(res: Response) {
    const origin = '*';
    return new Response(res.body, {
      status: res.status,
      headers: {
        'content-type': res.headers.get('content-type') || 'application/json',
        'access-control-allow-origin': origin,
        'access-control-allow-headers': 'authorization, content-type',
        'access-control-allow-methods': 'GET, POST, DELETE, OPTIONS'
      }
    });
  }
}

function json(obj: any, status = 200) {
  return new Response(JSON.stringify(obj), { status, headers: { 'content-type':'application/json' }});
}

export interface Env {
  ACCESS_TOKEN: string;  // секрет для API (Bearer)
  MASTER_KEY: string;    // base64(32 байта) — AES ключ шифрования приватников
  RPC_PRIMARY: string;
  RPC_FALLBACK?: string;
  PUMP_BASE?: string;
}
