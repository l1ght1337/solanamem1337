// apps/web/src/live/runner_pump.ts
import {
  Connection,
  Keypair,
  VersionedTransaction,
} from "@solana/web3.js";

// Собираем tx через PumpPortal Local API и возвращаем десериализованный VersionedTransaction
async function buildTradeTx(body: Record<string, any>): Promise<VersionedTransaction> {
  const res = await fetch("/x/pump/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`pumpportal ${res.status}: ${txt || "build tx failed"}`);
  }
  const raw = new Uint8Array(await res.arrayBuffer());
  return VersionedTransaction.deserialize(raw);
}


type Cfg = {
  mint: string;
  slippageBps: () => number;
  twap?: { slices: number; gapMs: number } | null;
  price: () => number;
  change1m: () => number;
  keypair: () => Keypair;
  tokenDecimals: () => number;
  tradeSize: () => number; // в SOL
  onLog: (lvl: "info" | "ok" | "warn" | "err", msg: string) => void;
  onUpdate: (bot: any) => void;
};

// Экспорт именно с таким именем, чтобы совпало с `then(m => m.runBot)`
export function runBot(connection: Connection, bot: any, cfg: Cfg) {
  let stopped = false;

  const act = async () => {
    if (stopped) return;

    // Простейший выбор стороны, логика стратегий не меняется
    const side: "buy" | "sell" =
      bot.strategy === "revert" ? (cfg.change1m() > 0 ? "sell" : "buy")
      : bot.strategy === "scalper" ? (Math.random() < 0.5 ? "buy" : "sell")
      : /* trend */ (cfg.change1m() >= 0 ? "buy" : "sell");

    const amountSol = Math.max(0.000001, cfg.tradeSize()); // SOL
    const slippagePct = Math.max(0, (cfg.slippageBps() || 0) / 100); // bps -> %

    try {
      const wallet = cfg.keypair();

      const body = {
        publicKey: wallet.publicKey.toBase58(),
        action: side,                        // "buy" | "sell"
        mint: cfg.mint,                      // адрес токена
        denominatedInSol: "true",            // указываем сумму в SOL
        amount: Number(amountSol.toFixed(9)),
        slippage: slippagePct,               // 0.5 == 0.5% (из bps/100)
        priorityFee: 0.00001,
        pool: "auto",                        // bonding-curve или Raydium после миграции
      };

      const vtx = await buildTradeTx(body);
      vtx.sign([wallet]);

      const sig = await connection.sendTransaction(vtx, { skipPreflight: false });
      await connection.confirmTransaction(sig, "confirmed");

      cfg.onLog(
        "ok",
        `${side.toUpperCase()} ${amountSol.toFixed(6)} SOL @ ${cfg.price().toFixed(9)} (${sig.slice(0,8)}…)`
      );
    } catch (e: any) {
      cfg.onLog("warn", `trade ${side} failed: ${e?.message || String(e)}`);
    }
  };

  // Планировщик тикеров, учитывает TWAP (если включен)
  let timer: any;
  const schedule = () => {
    clearTimeout(timer);
    const gap = Math.max(500, bot.speedMs || 3000);

    if (cfg.twap && cfg.twap.slices > 1) {
      let i = 0;
      const tw = () => {
        if (stopped) return;
        act().finally(() => {
          i++;
          if (i < cfg.twap!.slices) timer = setTimeout(tw, cfg.twap!.gapMs);
          else timer = setTimeout(schedule, gap);
        });
      };
      tw();
    } else {
      act().finally(() => (timer = setTimeout(schedule, gap)));
    }
  };

  schedule();
  return () => { stopped = true; clearTimeout(timer); };
}
