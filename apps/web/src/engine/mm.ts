// Упрощённый Avellaneda–Stoikov: спред + инвентори-скью.
// Работает вокруг mid (target), отдаёт котировки и рекомендованные размеры.

export type MMState = {
  inventory: number;       // токенов
  cash: number;            // SOL
  gamma: number;           // риск-аверсия
  kappa: number;           // эластичность спроса
  vol: number;             // sigma (из AI)
  tradeSize: number;       // базовый размер сделки в токенах
};

export type Quote = { bid: number; ask: number; sizeBid: number; sizeAsk: number };

export function avellanedaQuote(mid: number, s: MMState): Quote {
  const { gamma, kappa, vol, inventory, tradeSize } = s;

  // Теоретический оптимальный спред ~ gamma * sigma^2 / kappa
  const baseSpread = (gamma * vol * vol) / Math.max(1e-6, kappa);
  // Скью от инвентори: чем больше токенов — тем дальше bid, ближе ask
  const skew = 0.5 * gamma * inventory * vol;

  const spread = Math.max(1e-6, baseSpread + 1e-4); // safety
  const bid = mid * (1 - spread - Math.max(0, skew));
  const ask = mid * (1 + spread - Math.min(0, skew));

  // динамические размеры: уменьшаем сторону против инвентори
  const sizeBid = Math.max(0, tradeSize * (1 - Math.tanh(inventory * 0.3)));
  const sizeAsk = Math.max(0, tradeSize * (1 + Math.tanh(inventory * 0.3)));

  return { bid, ask, sizeBid, sizeAsk };
}
