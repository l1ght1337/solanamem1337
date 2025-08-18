// apps/web/src/live/runner_pump.ts
import { Connection, VersionedTransaction, PublicKey, Keypair } from '@solana/web3.js';

type Level = 'info' | 'ok' | 'warn' | 'err';

type RunOpts = {
  mint: string;
  slippageBps: () => number;               // bps, напр. 50 = 0.5%
  twap?: { slices: number; gapMs: number } | null;
  price: () => number;
  change1m: () => number;                   // -0.01 … +0.01
  keypair: () => Keypair;                   // ключ бота
  tokenDecimals: () => number;              // если не знаем — 9
  tradeSize: () => number;                  // сколько SOL тратить за сделку
  onLog: (lvl: Level, msg: string) => void;
  onUpdate: (bot: any) => void;
};

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

/** Базовые адреса: ваш воркер (VITE_API_BASE) → /x/pump, иначе прямой pumpportal.fun */
function getPumpBases(): string[] {
  const envBase = (import.meta as any)?.env?.VITE_API_BASE || '';
  let base = String(envBase || '').trim().replace(/\/+$/, '');
  if (base && !/\/x\/pump$/i.test(base)) base += '/x/pump';
  const list = [base, 'https://pumpportal.fun'].filter(Boolean);
  return [...new Set(list)];
}

async function withTimeout<T>(p: Promise<T>, ms = 12000): Promise<T> {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => reject(new Error('fetch timeout')), ms);
    p.then(v => { clearTimeout(t); resolve(v); }, e => { clearTimeout(t); reject(e); });
  });
}

/** Строим VTX через /api/trade-local (воркер или pump.fun). Возвращаем десериализованный VTX. */
async function buildTradeVtx(body: any): Promise<VersionedTransaction> {
  const bases = getPumpBases();
  let lastErr: any;
  for (const b of bases) {
    try {
      const res = await withTimeout(fetch(`${b}/api/trade-local`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Accept': 'application/octet-stream' },
        body: JSON.stringify(body),
      }), 15000);

      if (!res.ok) {
        const ct = res.headers.get('content-type') || '';
        if (ct.includes('application/json')) {
          const j = await res.json().catch(() => ({}));
          throw new Error(j?.error || j?.message || `HTTP ${res.status}`);
        } else {
          const t = await res.text().catch(() => '');
          throw new Error(`HTTP ${res.status} ${t || 'Bad Request'}`);
        }
      }
      const raw = new Uint8Array(await res.arrayBuffer());
      return VersionedTransaction.deserialize(raw);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('trade-local failed on all bases');
}

async function sendVtx(connection: Connection, kp: Keypair, vtx: VersionedTransaction): Promise<string> {
  vtx.sign([kp]);
  const sig = await connection.sendTransaction(vtx, { skipPreflight: false, maxRetries: 3 });
  await connection.confirmTransaction(sig, 'confirmed');
  return sig;
}

/** Узнаём uiAmount токена без spl-token: parsed accounts по mint. */
async function getTokenUiBalance(
  connection: Connection,
  owner: PublicKey,
  mint: PublicKey
): Promise<number> {
  try {
    const r = await connection.getParsedTokenAccountsByOwner(owner, { mint }, 'processed');
    const it = r.value?.[0]?.account?.data as any;
    const ui = Number(it?.parsed?.info?.tokenAmount?.uiAmount ?? 0);
    return isFinite(ui) ? ui : 0;
  } catch { return 0; }
}

/** Простое принятие решения */
function decideAction(bot: any, change1m: number) {
  const strat = (bot.strategy || 'trend') as 'trend' | 'revert' | 'scalper';
  // Пороги умеренные, без спама
  const BUY  = { trend: +0.004, revert: -0.006, scalper: +0.0015 } as const;
  const SELL = { trend: -0.003, revert: +0.004, scalper: +0.0008 } as const;

  if (!isFinite(change1m)) return 'hold';

  if (strat === 'revert') {
    if (change1m <= BUY.revert)  return 'buy';
    if (change1m >= SELL.revert) return 'sell';
    return 'hold';
  }
  if (strat === 'scalper') {
    if (change1m >= BUY.scalper)  return 'buy';
    if (change1m <= -SELL.scalper) return 'sell';
    return 'hold';
  }
  // trend
  if (change1m >= BUY.trend)  return 'buy';
  if (change1m <= SELL.trend) return 'sell';
  return 'hold';
}

/** Основной раннер */
export function runBot(connection: Connection, bot: any, opts: RunOpts) {
  let stopped = false;
  let lastTs = 0;
  let coolMs = Math.max(800, Number(bot.speedMs) || 8000);

  const loop = async () => {
    if (stopped) return;
    try {
      if (!bot.aiEnabled) {
        opts.onUpdate({ ...bot, last: 'hold' });
        await sleep(coolMs);
        return loop();
      }

      const now = Date.now();
      if (now - lastTs < coolMs) {
        await sleep(Math.max(200, coolMs - (now - lastTs)));
        return loop();
      }
      lastTs = now;

      const price = Number(opts.price() || 0);
      const ch1m  = Number(opts.change1m() || 0);
      const action = decideAction(bot, ch1m);

      if (action === 'hold') {
        opts.onUpdate({ ...bot, last: 'hold' });
        await sleep(coolMs);
        return loop();
      }

      const kp = opts.keypair();
      const mintPk = new PublicKey(opts.mint);
      const slippagePct = Math.max(0, (opts.slippageBps() || 0) / 100);

      if (action === 'buy') {
        const baseSol = Math.max(0, +opts.tradeSize() || 0);
        if (baseSol <= 0.0004) {
          opts.onLog('info', `Skip buy ${bot.name}: tradeSize too small`);
          opts.onUpdate({ ...bot, last: 'hold' });
          await sleep(coolMs);
          return loop();
        }

        const doBuy = async (amountSol: number) => {
          const body = {
            publicKey: kp.publicKey.toBase58(),
            action: 'buy',
            mint: mintPk.toBase58(),
            denominatedInSol: 'true',
            amount: amountSol,
            slippage: slippagePct,
            priorityFee: 0.00001,
            pool: 'auto',
          };
          const vtx = await buildTradeVtx(body);
          const sig = await sendVtx(connection, kp, vtx);

          bot.fills = (bot.fills || 0) + 1;
          bot.avgSol = bot.avgSol > 0 ? (bot.avgSol + price) / 2 : price;
          bot.last = `buy ${amountSol.toFixed(4)} SOL (${sig.slice(0,8)}…)`;
          opts.onLog('ok', `BUY ${bot.name}: ${amountSol.toFixed(6)} SOL @ ~${price.toFixed(9)} (${sig})`);
          opts.onUpdate({ ...bot });
        };

        const plan = opts.twap;
        if (plan && plan.slices > 1 && plan.gapMs > 200) {
          const per = baseSol / plan.slices;
          for (let i = 0; i < plan.slices; i++) {
            if (stopped) break;
            await doBuy(+per.toFixed(6));
            if (i < plan.slices - 1) await sleep(plan.gapMs);
          }
        } else {
          await doBuy(+baseSol.toFixed(6));
        }

        await sleep(coolMs);
        return loop();
      }

      if (action === 'sell') {
        const uiBal = await getTokenUiBalance(connection, kp.publicKey, mintPk);
        if (uiBal <= 0) {
          opts.onLog('info', `Skip sell ${bot.name}: no tokens`);
          opts.onUpdate({ ...bot, last: 'hold' });
          await sleep(coolMs);
          return loop();
        }

        const share = bot.strategy === 'scalper' ? 0.5 : 0.35;
        const dec = Math.max(0, Math.min(9, Number(opts.tokenDecimals() || 9)));
        const amountTok = +(uiBal * share).toFixed(Math.min(6, dec));
        if (amountTok <= 0) {
          opts.onUpdate({ ...bot, last: 'hold' });
          await sleep(coolMs);
          return loop();
        }

        const body = {
          publicKey: kp.publicKey.toBase58(),
          action: 'sell',
          mint: mintPk.toBase58(),
          denominatedInSol: 'false',
          amount: amountTok,
          slippage: slippagePct,
          priorityFee: 0.00001,
          pool: 'auto',
        };
        const vtx = await buildTradeVtx(body);
        const sig = await sendVtx(connection, kp, vtx);

        bot.fills = (bot.fills || 0) + 1;
        const pnl = amountTok * Math.max(0, price - (bot.avgSol || price));
        bot.realized = (bot.realized || 0) + pnl;
        bot.last = `sell ~${amountTok} TOK (${sig.slice(0,8)}…)`;

        opts.onLog('ok', `SELL ${bot.name}: ~${amountTok} TOK @ ~${price.toFixed(9)} (${sig})`);
        opts.onUpdate({ ...bot });

        await sleep(coolMs);
        return loop();
      }

      await sleep(coolMs);
      return loop();
    } catch (e: any) {
      const msg = e?.message || String(e);
      opts.onLog('warn', `runner: ${msg}`);
      bot.last = `err`;
      opts.onUpdate({ ...bot });
      await sleep(Math.max(1500, coolMs * 1.2));
      return loop();
    }
  };

  // старт
  loop();

  // стоппер
  return () => { stopped = true; };
}

export default runBot;
