import {
  Connection,
  PublicKey,
  ParsedAccountData,
} from '@solana/web3.js';

export async function getMintDecimals(c: Connection, mint: string): Promise<number> {
  const pk = new PublicKey(mint);
  const info = await c.getParsedAccountInfo(pk);
  const parsed = info.value?.data as ParsedAccountData | undefined;
  const dec = (parsed?.parsed as any)?.info?.decimals;
  if (typeof dec === 'number') return dec;
  // fallback (на случай non-parsed ответа)
  const raw = info.value?.data as Buffer | undefined;
  if (raw && raw.length >= 45) return raw[44]; // стандартный offset decimals
  return 9;
}

export async function getSPLBalance(c: Connection, owner: string, mint: string): Promise<bigint> {
  const ownerPk = new PublicKey(owner);
  const mintPk  = new PublicKey(mint);
  const resp = await c.getTokenAccountsByOwner(ownerPk, { mint: mintPk });
  let sum = 0n;
  for (const it of resp.value) {
    // raw layout: 64 offset for amount (8 bytes LE)
    const data = it.account.data;
    if (data.byteLength >= 72) {
      const view = new DataView(data.buffer, data.byteOffset + 64, 8);
      const lo = view.getUint32(0, true);
      const hi = view.getUint32(4, true);
      sum += (BigInt(hi) << 32n) + BigInt(lo);
    }
  }
  return sum;
}
