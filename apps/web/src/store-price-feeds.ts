// src/store-price-feeds.ts
// Унифицированная обёртка получения цены из внешних источников.
// ВАЖНО: единственный экспорт — fetchExternalPrice (никаких дублей)
import { scheduleFetch } from './utils/network';

export type ExtProvider =
  | 'dexscreener'
  | 'jupiter'
  | 'solanatracker'
  | 'custom'
  | 'pump_qn';

export interface ExtCfg {
  provider: ExtProvider;
  endpoint: string;   // базовый URL провайдера (или пусто — возьмём дефолт)
  apiKey?: string;    // для QuickNode / custom, если требуется
}

// ---------- helpers ----------
async function safeJSON<T>(url: string, init?: RequestInit): Promise<T | undefined> {
  try {
    const r = await scheduleFetch(url, { ...(init as any), timeoutMs: 8000, tries: 1 }, 'price');
    if (!r.ok) return;
    return (await r.json()) as T;
  } catch {
    return undefined;
  }
}
const trimSlash = (s: string) => (s || '').replace(/\/+$/, '');
const toNum = (x: any) => {
  const n = Number(x);
  return Number.isFinite(n) ? n : undefined;
};

// ---------- DEXSCREENER ----------
type DexResp = { pairs?: Array<{ priceUsd?: string | number }> };
async function fetchDexPrice(cfg: ExtCfg, mint: string): Promise<number | undefined> {
  const base = trimSlash(cfg.endpoint) || 'https://api.dexscreener.com';
  const url = `${base}/latest/dex/tokens/${mint}`;
  const j = await safeJSON<DexResp>(url);
  const price = j?.pairs?.[0]?.priceUsd;
  return toNum(price);
}

// ---------- JUPITER ----------
type JupResp = { data?: Record<string, { price?: number }> };
async function fetchJupPrice(cfg: ExtCfg, mint: string): Promise<number | undefined> {
  const base = trimSlash(cfg.endpoint) || 'https://price.jup.ag/v6/price';
  // v6 принимает ids=<mint>
  const url = `${base}?ids=${encodeURIComponent(mint)}`;
  const j = await safeJSON<JupResp>(url);
  const price = j?.data?.[mint]?.price;
  return toNum(price);
}

// ---------- SOLANATRACKER (best-effort / optional) ----------
type STResp = { data?: { price?: number } } | { price?: number };
async function fetchSTPrice(cfg: ExtCfg, mint: string): Promise<number | undefined> {
  // если указали кастомный endpoint — используем его; иначе пробуем дефолт (может меняться)
  const base = trimSlash(cfg.endpoint) || 'https://data.solanatracker.io';
  // у SolanaTracker нет стабильного free endpoint — здесь best-effort:
  const url = `${base}/price?ids=${encodeURIComponent(mint)}`;
  const j = await safeJSON<STResp>(url);
  const price = (j as any)?.price ?? (j as any)?.data?.price;
  return toNum(price);
}

// ---------- CUSTOM (твой собственный сервер), ожидаем { price } ----------
type CustomResp = { price?: number } | { data?: { price?: number } };
async function fetchCustomPrice(cfg: ExtCfg, mint: string): Promise<number | undefined> {
  if (!cfg.endpoint) return;
  const base = trimSlash(cfg.endpoint);
  // Общий контракт: твой сервер должен принять mint и вернуть { price } (или { data: { price } })
  const url = `${base}?mint=${encodeURIComponent(mint)}`;
  const j = await safeJSON<CustomResp>(url);
  const price = (j as any)?.price ?? (j as any)?.data?.price;
  return toNum(price);
}

// ---------- QUICKNODE Pump.fun ----------
type QNPumpResp = { price?: number } | { data?: { price?: number } };
async function fetchPumpPrice(cfg: ExtCfg, mint: string): Promise<number | undefined> {
  // В QuickNode аддоне «Pump Fun API» копируешь "Base URL".
  // Обычно: https://<...>.quiknode.pro/<token>/ + /price?mint=<MINT>
  if (!cfg.endpoint) return;
  const base = trimSlash(cfg.endpoint);
  const url = `${base}/price?mint=${encodeURIComponent(mint)}`;
  const headers: Record<string, string> = {};
  if (cfg.apiKey) headers['x-api-key'] = cfg.apiKey;

  const j = await safeJSON<QNPumpResp>(url, { headers });
  const price = (j as any)?.price ?? (j as any)?.data?.price;
  return toNum(price);
}

// ---------- ЕДИНСТВЕННАЯ ТОЧКА ВХОДА ----------
export async function fetchExternalPrice(
  cfg: ExtCfg,
  mint: string
): Promise<number | undefined> {
  if (!mint) return;
  switch (cfg.provider) {
    case 'dexscreener':
      return fetchDexPrice(cfg, mint);
    case 'jupiter':
      return fetchJupPrice(cfg, mint);
    case 'solanatracker':
      return fetchSTPrice(cfg, mint);
    case 'custom':
      return fetchCustomPrice(cfg, mint);
    case 'pump_qn':
      return fetchPumpPrice(cfg, mint);
    default:
      return undefined;
  }
}