// Набор простых симуляторов "толпы": trend / revert / scalper.
// Возвращают сделки, которые исполнились по котировкам MM.

export type BotKind = 'trend' | 'revert' | 'scalper';

export type Bot = {
  id: string;
  name: string;
  kind: BotKind;
  cash: number;            // SOL
  pos: number;             // токенов
  avg: number;             // средняя цена по токену (SOL)
  realizedPnl: number;     // SOL
};

export type CrowdParams = {
  intensity: number;       // 0..1
  pressure: number;        // -1..+1
};

export type Fill = { side: 'buy'|'sell'; qty: number; px: number; botId: string };

const rnd = (a=0,b=1) => a + Math.random()*(b-a);

export function stepBots(
  bots: Bot[],
  mmBid: number, mmAsk: number,
  crowd: CrowdParams,
  mid: number,
  maxQty: number
): { updated: Bot[]; fills: Fill[] } {

  const fills: Fill[] = [];
  const updated: Bot[] = bots.map(b => ({...b}));

  const { intensity, pressure } = crowd;

  for (const b of updated) {
    // Базовая вероятность активного действия
    let pAct = 0.05 + 0.4 * intensity;

    // Модификатор от "pressure"
    pAct += 0.15 * Math.abs(pressure);

    if (Math.random() > pAct) continue;

    // Решаем сторону исходя из типа и отклонения
    const dev = (mid - b.avg) / Math.max(1e-9, b.avg || mid);
    let side: 'buy'|'sell' = 'buy';

    switch (b.kind) {
      case 'trend':
        side = (pressure >= 0 ? 'buy' : 'sell');
        break;
      case 'revert':
        side = (dev > 0 ? 'sell' : 'buy');
        break;
      case 'scalper':
        side = (Math.random() < 0.5 ? 'buy' : 'sell');
        break;
    }

    // Лимит по кэшу/позиции
    const qty = Math.max(0, Math.min(maxQty, (b.cash / mid) * 0.2 + 0.0001));
    if (qty <= 0) continue;

    if (side === 'buy' && b.cash >= mmAsk * qty) {
      // исполнился по ask
      b.cash -= mmAsk * qty;
      b.pos  += qty;
      b.avg   = b.avg ? (b.avg * (b.pos - qty) + mmAsk * qty) / b.pos : mmAsk;
      fills.push({ side, qty, px: mmAsk, botId: b.id });
    } else if (side === 'sell' && b.pos >= qty) {
      b.pos  -= qty;
      b.cash += mmBid * qty;
      // реализация PnL
      const pnl = (mmBid - b.avg) * qty;
      b.realizedPnl += pnl;
      if (b.pos === 0) b.avg = 0;
      fills.push({ side, qty, px: mmBid, botId: b.id });
    }
  }

  return { updated, fills };
}
