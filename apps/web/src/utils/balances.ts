import { AccountInfo, Connection, PublicKey } from "@solana/web3.js";
import { TOKEN_PROGRAM_ID } from "@solana/spl-token";

// Utility: split an array into chunks of size n
function chunkArray<T>(arr: T[], n: number): T[][] {
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
  return out;
}

export async function fetchMultipleAccountInfos(
  connection: Connection,
  pubkeys: PublicKey[]
): Promise<(AccountInfo<Buffer> | null)[]> {
  const out: (AccountInfo<Buffer> | null)[] = [];
  if (!pubkeys.length) return out;

  const anyConn = connection as any;
  const chunks = chunkArray(pubkeys, 100);

  // Preferred: getMultipleAccountsInfo (modern web3.js)
  if (typeof anyConn.getMultipleAccountsInfo === "function") {
    for (const part of chunks) {
      // getMultipleAccountsInfo accepts PublicKey[]
      const infos = await connection.getMultipleAccountsInfo(part);
      out.push(...infos);
    }
    return out;
  }

  // Fallback: legacy getMultipleAccounts (returns account data with value[])
  if (typeof anyConn.getMultipleAccounts === "function") {
    for (const part of chunks) {
      const resp = await anyConn.getMultipleAccounts(part);
      const value: Array<{ data: Buffer; executable: boolean; lamports: number; owner: PublicKey; rentEpoch?: number } | null> = resp?.value || [];
      const mapped: (AccountInfo<Buffer> | null)[] = value.map((v) =>
        v
          ? ({
              data: v.data,
              executable: v.executable,
              lamports: v.lamports,
              owner: v.owner,
              rentEpoch: v.rentEpoch ?? 0,
            } as AccountInfo<Buffer>)
          : null
      );
      out.push(...mapped);
    }
    return out;
  }

  // Fallback-of-last-resort: individual getAccountInfo calls (chunked in parallel)
  for (const part of chunks) {
    const infos = await Promise.all(
      part.map((pk) => connection.getAccountInfo(pk).catch(() => null))
    );
    out.push(...infos);
  }
  return out;
}

export async function getOwnerTokenAccounts(connection: Connection, owner: PublicKey) {
  try {
    const resp = await connection.getParsedTokenAccountsByOwner(owner, { programId: TOKEN_PROGRAM_ID });
    return (resp.value || []).map((it) => {
      const ata = it.pubkey;
      const info: any = (it.account.data as any).parsed?.info;
      const mint = String(info?.mint || "");
      const amount = Number(info?.tokenAmount?.amount || 0);
      return { mint, ata, amount };
    });
  } catch {
    return [] as Array<{ mint: string; ata: PublicKey; amount: number }>;
  }
}
