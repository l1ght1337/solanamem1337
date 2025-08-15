// src/store/store-price-feeds.ts
type ExtCfg = { provider: 'dexscreener' | 'jupiter' };

export async function fetchExternalPrice(cfg: ExtCfg, mint: string): Promise<number | undefined> {
  try {
    if (cfg.provider === 'dexscreener') {
      // https://api.dexscreener.com/latest/dex/tokens/<mint>
      const r = await fetch(`https://api.dexscreener.com/latest/dex/tokens/${mint}`);
      const j = await r.json();
      const p = j?.pairs?.[0]?.priceUsd;
      return p ? Number(p) : undefined;
    } else {
      // Jupiter price v6
      const r = await fetch(`https://price.jup.ag/v6/price?ids=${mint}`);
      const j = await r.json();
      const p = j?.data?.[mint]?.price;
      return p ? Number(p) : undefined;
    }
  } catch (e) {
    console.warn('price fetch failed', e);
    return undefined;
  }
}
