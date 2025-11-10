// apps/web/src/utils/pump.ts
// light base58 verifier to avoid type deps during build; fall back to length check
let bs58: any = undefined;

export function parseMint(input: string): string | null {
  const raw = String(input || '').trim();
  if (!raw) return null;
  const fromQuery = (() => {
    try {
      const u = new URL(raw);
      const q = u.searchParams.get('mint');
      if (q) return q;
      // pump.fun url pattern /coin/<mint>
      const m = u.pathname.match(/\/coin\/([1-9A-HJ-NP-Za-km-z]{32,44})/);
      if (m) return m[1];
      return null;
    } catch { return null; }
  })();
  const cand = fromQuery || raw;
  // base58 length check
  if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(cand)) return null;
  try {
    if (bs58) {
      const bytes = bs58.decode(cand);
      if (bytes.length === 32) return cand;
    } else {
      // Fallback: assume valid if it matches regex and length in [43,44]; common case
      if (cand.length >= 32 && cand.length <= 44) return cand;
    }
  } catch {}
  return null;
}

const pumpDomains = ["pump.fun", "bonk.fun", "letsbonk.fun"];

export function isPumpLikeUrl(input: string): boolean {
  if (!input) return false;
  try {
    const host = new URL(input).hostname.toLowerCase();
    return pumpDomains.some(
      (domain) => host === domain || host.endsWith(`.${domain}`)
    );
  } catch {
    return false;
  }
}

