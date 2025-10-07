// src/lib/jupiter-lite.ts
export type JupQuote = any; // тип подставь свой

type SwapArgs = {
  jupBase: string;             // https://lite-api.jup.ag
  userPubkey: string;          // кошелёк бота
  quoteResponse: JupQuote;     // ответ /quote
  asLegacy?: boolean;          // лучше true для pump
  cuPrice: number;             // μLamports/CU
  recentBlockhash: string;     // из TxEngine.getHotBlockhash
};

export async function fetchSwapTx(args: SwapArgs): Promise<Uint8Array> {
  const url = `${args.jupBase}/swap/v1/swap`;
  const body = {
    quoteResponse: args.quoteResponse,
    userPublicKey: args.userPubkey,
    asLegacyTransaction: args.asLegacy ?? true,
    // критично: прокидываем наш CU price
    computeUnitPriceMicroLamports: args.cuPrice,
    // ускоряем сборку с уже полученным блокхешем
    dynamicComputeUnitLimit: true,
    // передаём known recentBlockhash, чтобы транза была валидна дольше
    recentBlockhash: args.recentBlockhash
  };

  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) {
    const t = await r.text();
    throw new Error(`JUP swap error ${r.status}: ${t}`);
  }
  const j = await r.json();
  const base64 = j?.swapTransaction || j?.swapTransactionEncoded || j?.swapTransactionData;
  if (!base64) throw new Error('JUP: missing swapTransaction');
  return Buffer.from(base64, 'base64');
}
