// apps/web/src/utils/confirm.ts
import { Connection } from "@solana/web3.js";

export async function confirmManyHttp(
  connection: Connection,
  signatures: string[],
  opts?: { commitment?: "processed"|"confirmed"|"finalized"; timeoutMs?: number; pollMs?: number; searchTransactionHistory?: boolean }
) {
  const commitment = opts?.commitment ?? "confirmed";
  const timeoutMs = opts?.timeoutMs ?? 20000;
  const pollMs = opts?.pollMs ?? 350;
  const searchTransactionHistory = opts?.searchTransactionHistory ?? true;

  const deadline = Date.now() + timeoutMs;
  const done = new Set<string>();

  while (done.size < signatures.length && Date.now() < deadline) {
    const st = await connection.getSignatureStatuses(signatures, { searchTransactionHistory });
    const vals = st.value || [];
    for (let i = 0; i < signatures.length; i++) {
      const v = vals[i];
      if (!v) continue;
      if (v.err == null && (v.confirmations === null || v.confirmations > 0)) {
        done.add(signatures[i]);
      } else if (v.err) {
        done.add(signatures[i]); // считаем завершённой с ошибкой — разберём в логах
      }
    }
    if (done.size >= signatures.length) break;
    await new Promise(r => setTimeout(r, pollMs));
  }
  return Array.from(done);
}
