// Полностью HTTP-подтверждение без WebSocket
import type { Commitment, Connection, RpcResponseAndContext, SignatureResult } from '@solana/web3.js';

export async function confirmSigHttp(
  connection: Connection,
  signature: string,
  commitment: Commitment = 'confirmed',
  timeoutMs = 90_000,
  pollMs = 1200
): Promise<RpcResponseAndContext<SignatureResult | null>> {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const st = await connection.getSignatureStatuses([signature], { searchTransactionHistory: false });
    const v = st?.value?.[0] || null;
    // Успешно: либо уже финализирована, либо есть confirmations === null
    if (v && !v.err && (v.confirmations === null || (v.confirmationStatus ?? '') >= commitment)) {
      return { context: st.context, value: v };
    }
    if (v?.err) throw new Error(`tx error: ${JSON.stringify(v.err)}`);
    await new Promise(r => setTimeout(r, pollMs));
  }
  throw new Error('confirm timeout');
}
