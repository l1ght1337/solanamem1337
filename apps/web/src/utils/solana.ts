import {
  Connection,
  PublicKey,
  ParsedAccountData,
} from '@solana/web3.js';
import { TOKEN_2022_PROGRAM_ID } from '@solana/spl-token';

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
  let sum = 0n;

  // classic SPL by mint
  try {
    const resp = await c.getTokenAccountsByOwner(ownerPk, { mint: mintPk });
    for (const it of resp.value) {
      const data = it.account.data as unknown as Uint8Array;
      if (data && data.byteLength >= 72) {
        const view = new DataView(data.buffer, data.byteOffset + 64, 8);
        const lo = view.getUint32(0, true);
        const hi = view.getUint32(4, true);
        sum += (BigInt(hi) << 32n) + BigInt(lo);
      }
    }
  } catch {}

  // token-2022: нужно фильтровать по mint вручную
  try {
    const resp22 = await c.getTokenAccountsByOwner(ownerPk, { programId: TOKEN_2022_PROGRAM_ID });
    for (const it of resp22.value) {
      const data = it.account.data as unknown as Uint8Array;
      if (!data || data.byteLength < 72) continue;
      // mint находится в первых 32 байтах
      const mintBytes = data.slice(0, 32);
      const accMint = new PublicKey(mintBytes);
      if (!accMint.equals(mintPk)) continue;
      const view = new DataView(data.buffer, data.byteOffset + 64, 8);
      const lo = view.getUint32(0, true);
      const hi = view.getUint32(4, true);
      sum += (BigInt(hi) << 32n) + BigInt(lo);
    }
  } catch {}

  return sum;
}
