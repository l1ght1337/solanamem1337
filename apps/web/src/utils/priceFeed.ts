// apps/web/src/utils/priceFeed.ts
import { logger } from './logger';

export async function getTokenPriceSOL(mint: string, abort?: AbortSignal): Promise<{ price: number | null; source: string; reason?: string }>{
  const id = String(mint || '').trim();
  if (!id) return { price: null, source: 'none', reason: 'no-mint' };

  // a) Jupiter v6 direct
  try {
    const u = `https://price.jup.ag/v6/price?ids=${encodeURIComponent(id)}`;
    const r = await fetch(u, { signal: abort });
    if (r.ok) {
      const j = await r.json().catch(() => ({}));
      const p = Number(j?.data?.[id]?.price);
      if (Number.isFinite(p) && p > 0) return { price: p, source: 'jupiter' };
    } else {
      logger.warn(`Jupiter price HTTP ${r.status}`);
    }
  } catch (e: any) {
    logger.warn(`Jupiter price error: ${e?.message || String(e)}`);
  }

  // b) Optional Cloudflare Worker proxy
  try {
    const API_BASE = ((import.meta as any).env?.VITE_API_BASE || '').replace(/\/+$/, '');
    if (API_BASE) {
      const u = `${API_BASE}/price?mint=${encodeURIComponent(id)}`;
      const r = await fetch(u, { signal: abort });
      if (r.ok) {
        const j = await r.json().catch(() => ({}));
        const p = Number(j?.price ?? j?.data?.price);
        if (Number.isFinite(p) && p > 0) return { price: p, source: 'proxy' };
      } else {
        logger.warn(`Proxy price HTTP ${r.status}`);
      }
    }
  } catch (e: any) {
    logger.warn(`Proxy price error: ${e?.message || String(e)}`);
  }

  logger.error(`Price unavailable for ${id}`);
  return { price: null, source: 'none', reason: 'unavailable/CORS' };
}
