// apps/web/src/utils/confirm.ts
import type { Connection } from "@solana/web3.js";

export type ConfirmOpts = {
  commitment?: "processed" | "confirmed" | "finalized";
  timeoutMs?: number;
  pollMs?: number;
  searchTransactionHistory?: boolean;
};

/** Проверка, достаточно ли подтверждений для запрошенного уровня commitment */
function satisfied(status: any | null | undefined, commitment: ConfirmOpts["commitment"]) {
  if (!status) return false;
  if (status.err) throw new Error(typeof status.err === "string" ? status.err : "transaction error");
  const want = commitment ?? "confirmed";

  // Новое поле confirmationStatus: 'processed' | 'confirmed' | 'finalized'
  const cs: "processed" | "confirmed" | "finalized" | null | undefined = status.confirmationStatus;

  if (cs) {
    if (want === "finalized") return cs === "finalized";
    if (want === "confirmed") return cs === "confirmed" || cs === "finalized";
    return cs === "processed" || cs === "confirmed" || cs === "finalized";
  }

  // Fallback на старые поля: confirmations === null ⇒ rooted/finalized
  const conf: number | null | undefined = status.confirmations;
  if (want === "finalized") return conf === null;
  if (want === "confirmed") return (conf ?? 0) > 0 || conf === null;
  return (conf ?? 0) >= 0;
}

/** Подтверждение одной сигнатуры через HTTP-поллинг (без вебсокетов). */
export async function confirmSigHttp(
  connection: Connection,
  signature: string,
  opts?: ConfirmOpts
): Promise<void> {
  const commitment = opts?.commitment ?? "confirmed";
  const timeoutMs = opts?.timeoutMs ?? 20_000;
  const pollMs = opts?.pollMs ?? 350;
  const searchTransactionHistory = opts?.searchTransactionHistory ?? true;

  const deadline = Date.now() + timeoutMs;

  // Быстрая проверка статуса истории
  while (Date.now() < deadline) {
    const res = await connection.getSignatureStatuses([signature], { searchTransactionHistory });
    const st = res.value?.[0];
    if (satisfied(st, commitment)) return;
    await new Promise((r) => setTimeout(r, pollMs));
  }
  throw new Error(`confirmSigHttp timeout after ${timeoutMs}ms`);
}

/** Пакетное подтверждение нескольких сигнатур (возвращает список подтверждённых/закрытых). */
export async function confirmManyHttp(
  connection: Connection,
  signatures: string[],
  opts?: ConfirmOpts
): Promise<string[]> {
  const commitment = opts?.commitment ?? "confirmed";
  const timeoutMs = opts?.timeoutMs ?? 25_000;
  const pollMs = opts?.pollMs ?? 350;
  const searchTransactionHistory = opts?.searchTransactionHistory ?? true;

  const uniq = Array.from(new Set(signatures.filter(Boolean)));
  if (uniq.length === 0) return [];

  const deadline = Date.now() + timeoutMs;
  const done = new Set<string>();

  const chunk = <T,>(arr: T[], n: number) => {
    const out: T[][] = [];
    for (let i = 0; i < arr.length; i += n) out.push(arr.slice(i, i + n));
    return out;
  };

  while (done.size < uniq.length && Date.now() < deadline) {
    for (const part of chunk(uniq.filter((s) => !done.has(s)), 250)) {
      const res = await connection.getSignatureStatuses(part, { searchTransactionHistory });
      const vals = res.value || [];
      for (let i = 0; i < part.length; i++) {
        const st = vals[i];
        try {
          if (satisfied(st, commitment)) done.add(part[i]);
        } catch {
          // Ошибочная/отклонённая транзакция — тоже «закрыта», чтобы не зависать
          done.add(part[i]);
        }
      }
    }
    if (done.size >= uniq.length) break;
    await new Promise((r) => setTimeout(r, pollMs));
  }

  return Array.from(done);
}

// На всякий случай для обратной совместимости можно экспортировать алиас
export const confirmSig = confirmSigHttp;
