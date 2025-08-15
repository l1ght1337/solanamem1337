// apps/web/src/external/pumpportal.ts
type TradeMsg = {
  type: "tokenTrade";
  mint: string;
  // формат в ответах может меняться; пытаемся вычислить цену гибко
  // часто приходят поля вроде priceSol или amounts в SOL/Token
  priceSol?: number;
  solAmount?: number;
  tokenAmount?: number;
  amount?: number;        // иногда для SOL
  tokens?: number;        // иногда для токенов
  side?: "buy" | "sell";
  ts?: number;
};

type MigrationMsg = { type: "migration"; mint: string; ts?: number };

export type PumpPortalSub = {
  ws: WebSocket;
  mints: Set<string>;
  detach: () => void;
  subscribe: (mint: string) => void;
  unsubscribe: (mint: string) => void;
};

export function attachPumpPortalFeed(opts: {
  mint: string;
  onPrice: (p: number) => void;
  onCandle: (t: number, p: number) => void;
  onMigration?: () => void;
}): PumpPortalSub {
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  const mints = new Set<string>();
  let ready = false;

  const send = (obj: any) => {
    const s = JSON.stringify(obj);
    if (ws.readyState === 1) ws.send(s);
    else ws.addEventListener("open", () => ws.send(s), { once: true });
  };

  const subscribe = (mint: string) => {
    mints.add(mint);
    if (!ready) return;
    send({ method: "subscribeTokenTrade", keys: [mint] });
    send({ method: "subscribeMigration", keys: [mint] });
  };
  const unsubscribe = (mint: string) => {
    if (!mints.has(mint)) return;
    mints.delete(mint);
    if (!ready) return;
    send({ method: "unsubscribeTokenTrade", keys: [mint] });
  };

  ws.addEventListener("open", () => {
    ready = true;
    // подписки
    if (mints.size === 0) mints.add(opts.mint);
    send({ method: "subscribeTokenTrade", keys: Array.from(mints) });
    send({ method: "subscribeMigration", keys: Array.from(mints) });
  });

  ws.addEventListener("message", (ev) => {
    try {
      const msg = JSON.parse(ev.data as string);
      if (!msg) return;

      // Trade
      if (msg.type === "tokenTrade") {
        const t = msg as TradeMsg;
        // пытаемся извлечь цену в SOL за 1 токен
        let price = t.priceSol;
        if (!price) {
          const sol =
            t.solAmount ?? t.amount ?? undefined;
          const tok =
            t.tokenAmount ?? t.tokens ?? undefined;
          if (sol && tok && tok > 0) price = sol / tok;
        }
        if (price && isFinite(price)) {
          const now = Date.now();
          const m = Math.floor(now / 60000) * 60000;
          opts.onPrice(price);
          opts.onCandle(m, price);
        }
      }

      // Migration
      if (msg.type === "migration") {
        (opts.onMigration || (() => {}))();
      }
    } catch {}
  });

  const detach = () => {
    try {
      if (ready && mints.size) {
        send({ method: "unsubscribeTokenTrade", keys: Array.from(mints) });
      }
    } catch {}
    try { ws.close(); } catch {}
  };

  return { ws, mints, detach, subscribe, unsubscribe };
}
