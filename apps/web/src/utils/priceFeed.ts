// apps/web/src/utils/priceFeed.ts
// Получение цены токена в SOL без обращения к price.jup.ag:
// 1) Jupiter QUOTE: price = 1 / (outTokens for 1 SOL)
// 2) Fallback: Dexscreener priceNative в SOL
import { scheduleFetch } from "./network";
import { getJupiterQuote, WSOL } from "./jupiter";

type PriceSource = "jupiter" | "dexscreener" | "unavailable";

export async function getTokenPriceSOL(
  mint: string,
  signal?: AbortSignal,
): Promise<{ price: number | null; reason?: string; source?: PriceSource }> {
  try {
    // 1) Jupiter QUOTE: 1 SOL -> TOKEN
    const oneSolLamports = 1_000_000_000;
    const q: any = await getJupiterQuote({
      inputMint: WSOL,
      outputMint: mint,
      amount: oneSolLamports,
    });

    const out = Number(q?.outAmount || 0);
    const dec = Number(q?.outputMintDecimals ?? 9);
    if (out > 0 && Number.isFinite(dec)) {
      const tokensFor1Sol = out / Math.pow(10, dec);
      if (tokensFor1Sol > 0) {
        const priceInSol = 1 / tokensFor1Sol;
          return { price: +priceInSol.toFixed(12), source: "jupiter" };
      }
    }
  } catch {
    // мягкий фолбэк ниже
  }

  // 2) Dexscreener (берём пару с SOL или первую доступную)
  try {
    const r = await scheduleFetch(
      `https://api.dexscreener.com/latest/dex/tokens/${encodeURIComponent(mint)}`,
        { timeoutMs: 12_000, tries: 1, signal } as any,
      "price"
    );
    if (r?.ok) {
      const j = await r.json().catch(() => ({}));
      const pair = Array.isArray(j?.pairs)
        ? j.pairs.find((p: any) => (p?.quoteToken?.symbol || "").toUpperCase() === "SOL") ||
          j.pairs[0]
        : null;
      const pv = Number(pair?.priceNative || 0); // уже в SOL
        if (pv > 0) return { price: pv, source: "dexscreener" };
    }
  } catch {
    // ignore
  }

  return { price: null, reason: "unavailable", source: "unavailable" };
}

