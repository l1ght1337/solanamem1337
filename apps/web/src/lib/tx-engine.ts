// src/lib/tx-engine.ts
import {
  Connection, VersionedTransaction, Transaction, Keypair,
  PublicKey, LAMPORTS_PER_SOL
} from '@solana/web3.js';

type RpcPair = { primary: string; fallback?: string };
type EngineOpts = {
  rpc: RpcPair;
  commitment?: 'processed'|'confirmed'|'finalized';
  hedgingDelayMs?: number; // через сколько ms запускать фолбэк-отправку
  statusPollMs?: number;   // период батч-поллера статусов
  maxAwaitSlots?: number;  // через сколько слотов эскалировать/пересобирать
  priorityTiers?: number[]; // μLamports per CU
};

type SendResult = {
  ok: boolean;
  sig?: string;
  err?: any;
  attempts: number;
  escalations: number;
  usedCuPrice?: number;
};

type BuildTxParams = {
  // текущая «ступень» приорити-фии в μLamports/CU
  computeUnitPriceMicroLamports: number;
  // актуальный блокхеш для сборки
  recentBlockhash: string;
  // высота «последнего валидного» блока (для дедлайнов)
  lastValidBlockHeight: number;
};

type BuildTxFn = (p: BuildTxParams) => Promise<VersionedTransaction|Transaction>;

export function createTxEngine(opts: EngineOpts) {
  const {
    rpc, commitment = 'processed', hedgingDelayMs = 200,
    statusPollMs = 350, maxAwaitSlots = 2,
    priorityTiers = [50, 100, 200, 400],
  } = opts;

  const conn = new Connection(rpc.primary, { commitment });
  const connFallback = rpc.fallback ? new Connection(rpc.fallback, { commitment }) : null;

  // --- блокхеш кэш ---
  let cached: { bh: string; lbh: number; fetchedAt: number } | null = null;
  async function refreshBlockhash() {
    const { blockhash, lastValidBlockHeight } = await conn.getLatestBlockhash(commitment);
    cached = { bh: blockhash, lbh: lastValidBlockHeight, fetchedAt: Date.now() };
    return cached!;
  }
  async function getHotBlockhash() {
    if (!cached) return refreshBlockhash();
    // обновляем заранее (задел ~60 блоков)
    const current = await conn.getBlockHeight(commitment);
    if (current > cached.lbh - 60) return refreshBlockhash();
    return cached;
  }

  // --- батч-пуллер статусов ---
  const pending = new Map<string, { res: (v:any)=>void, rej:(e:any)=>void }>();
  let pollerRunning = false;

  function ensurePoller() {
    if (pollerRunning) return;
    pollerRunning = true;
    (async function loop() {
      while (pending.size) {
        const keys = Array.from(pending.keys()).slice(0, 256);
        try {
          const st = await conn.getSignatureStatuses(keys, { searchTransactionHistory: false });
          const list = st.value;
          for (let i = 0; i < keys.length; i++) {
            const sig = keys[i];
            const it = pending.get(sig);
            if (!it) continue;
            const s = list[i];
            if (s?.confirmationStatus || s?.err !== null) {
              pending.delete(sig);
              it.res(s);
            }
          }
        } catch {}
        await new Promise(r => setTimeout(r, statusPollMs));
      }
      pollerRunning = false;
    })();
  }

  async function waitProcessed(sig: string, startSlot: number, maxSlots: number) {
    return new Promise<any>((resolve, reject) => {
      pending.set(sig, { res: resolve, rej: reject });
      ensurePoller();
      // safety deadline по слотам
      (async () => {
        try {
          while (true) {
            const slot = await conn.getSlot(commitment);
            if (slot - startSlot >= maxSlots) {
              const it = pending.get(sig);
              if (it) { pending.delete(sig); }
              return resolve(null); // «таймаут по слотам»
            }
            await new Promise(r => setTimeout(r, 200));
          }
        } catch (e) {
          const it = pending.get(sig);
          if (it) pending.delete(sig);
          resolve(null);
        }
      })();
    });
  }

  // --- hedged broadcast sendRawTransaction ---
  async function broadcast(raw: Buffer, skipPreflight = true): Promise<string> {
    const payload = {
      jsonrpc: '2.0', id: 1, method: 'sendRawTransaction',
      params: [raw.toString('base64'), { skipPreflight, maxRetries: 0 }]
    };

    const post = (url: string) =>
      fetch(url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(payload)
      }).then(r => r.json());

    let firedFallback = false;
    const primaryP = post(rpc.primary);
    let fallbackP: Promise<any> | null = null;

    const t = setTimeout(() => {
      if (rpc.fallback && !firedFallback) {
        firedFallback = true;
        fallbackP = post(rpc.fallback!);
      }
    }, hedgingDelayMs);

    const res = await Promise.any([primaryP, (async () => {
      if (!fallbackP) await new Promise(r => setTimeout(r, hedgingDelayMs + 5));
      return fallbackP!;
    })()].filter(Boolean) as Promise<any>[]);
    clearTimeout(t);

    if (res?.result) return res.result;
    // если Any не дал result – разрулим вручную
    const pr = await primaryP.catch(()=>null);
    if (pr?.result) return pr.result;
    if (fallbackP) {
      const fb = await fallbackP.catch(()=>null);
      if (fb?.result) return fb.result;
    }
    const err = pr?.error || (await fallbackP)?.error || { message: 'sendRawTransaction failed' };
    throw new Error(typeof err === 'string' ? err : (err.message || JSON.stringify(err)));
  }

  // публичный метод
  async function sendWithRetries(buildTx: BuildTxFn): Promise<SendResult> {
    let escalations = 0;
    let attempts = 0;

    while (true) {
      const { bh, lbh } = await getHotBlockhash();
      const cuPrice = priorityTiers[Math.min(escalations, priorityTiers.length - 1)];
      const tx = await buildTx({ computeUnitPriceMicroLamports: cuPrice, recentBlockhash: bh, lastValidBlockHeight: lbh });
      attempts++;

      // serialize
      let raw: Buffer;
      try {
        if ((tx as any).serialize) {
          raw = Buffer.from((tx as any).serialize());
        } else {
          raw = Buffer.from((tx as VersionedTransaction).serialize());
        }
      } catch (e) {
        return { ok: false, err: e, attempts, escalations, usedCuPrice: cuPrice };
      }

      // broadcast
      let sig: string;
      try {
        sig = await broadcast(raw, true);
      } catch (e) {
        // типичные ошибки RPC (429/5xx) гасим эскалацией либо новой сборкой
        escalations++;
        if (escalations >= priorityTiers.length) return { ok: false, err: e, attempts, escalations, usedCuPrice: cuPrice };
        continue;
      }

      // ждём processed коротко; если не пришло — эскалируем/пересобираем
      const startSlot = await conn.getSlot(commitment);
      const st = await waitProcessed(sig, startSlot, maxAwaitSlots);

      if (st && st.err == null) {
        return { ok: true, sig, attempts, escalations, usedCuPrice: cuPrice };
      }
      // не успела попасть в слот либо err != null → эскалируем
      escalations++;
      if (escalations >= priorityTiers.length) {
        // одна последняя попытка с обновлением блокхеша
        const cur = await conn.getBlockHeight(commitment);
        if (cur >= lbh - 1) await refreshBlockhash();
      }
      // цикл +1
    }
  }

  return { sendWithRetries, getHotBlockhash, refreshBlockhash, connection: conn };
}
