import {
  Connection,
  PublicKey,
  ParsedAccountData,
} from '@solana/web3.js';
import {
  TOKEN_PROGRAM_ID,
  TOKEN_2022_PROGRAM_ID,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';

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

/** Определяем, под какой программой создан mint (classic или token-2022). */
export async function detectTokenProgramId(
  connection: Connection,
  mintPk: PublicKey,
): Promise<PublicKey | null> {
  try {
    const mintInfo = await connection.getAccountInfo(mintPk, 'processed');
    return mintInfo ? mintInfo.owner : null;
  } catch {
    return null;
  }
}

/** Ищем ATA сразу в обеих программах. Возвращаем первую существующую. */
export async function findAtaAnyTokenProgram(
  connection: Connection,
  ownerPk: PublicKey,
  mintPk: PublicKey,
): Promise<{ ata: PublicKey | null; programId: PublicKey | null }> {
  const ataClassic = getAssociatedTokenAddressSync(
    mintPk,
    ownerPk,
    false,
    TOKEN_PROGRAM_ID,
  );
  const ataT22 = getAssociatedTokenAddressSync(
    mintPk,
    ownerPk,
    false,
    TOKEN_2022_PROGRAM_ID,
  );

  try {
    const [accClassic, accT22] = await connection.getMultipleAccountsInfo(
      [ataClassic, ataT22],
      'processed',
    );
    if (accClassic) return { ata: ataClassic, programId: TOKEN_PROGRAM_ID };
    if (accT22) return { ata: ataT22, programId: TOKEN_2022_PROGRAM_ID };
    return { ata: null, programId: null };
  } catch {
    return { ata: null, programId: null };
  }
}

/**
 * Безопасное получение баланса SPL. Возвращает число токенов (в минимальных единицах),
 * не бросает исключений: если аккаунт/ATA отсутствуют — возвращает 0.
 */
export async function getSPLBalance(
  connection: Connection,
  owner: string | PublicKey,
  mint: string | PublicKey,
): Promise<bigint> {
  const ownerPk = typeof owner === 'string' ? new PublicKey(owner) : owner;
  const mintPk = typeof mint === 'string' ? new PublicKey(mint) : mint;

  const mintOwner = await detectTokenProgramId(connection, mintPk);
  if (!mintOwner) {
    return 0n;
  }

  const { ata } = await findAtaAnyTokenProgram(connection, ownerPk, mintPk);
  if (!ata) {
    return 0n;
  }

  try {
    const bal = await connection.getTokenAccountBalance(ata, 'processed');
    return BigInt(bal?.value?.amount ?? '0');
  } catch {
    const info = await connection.getAccountInfo(ata, 'processed');
    if (!info || !info.data || info.data.length < 72) return 0n;
    const view = new DataView(
      info.data.buffer,
      info.data.byteOffset,
      info.data.byteLength,
    );
    const lo = view.getUint32(64, true);
    const hi = view.getUint32(68, true);
    return (BigInt(hi) << 32n) | BigInt(lo);
  }
}
