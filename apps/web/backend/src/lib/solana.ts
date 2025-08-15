import { Connection, VersionedTransaction, Transaction } from '@solana/web3.js';

export function getConn(rpcPrimary: string, rpcFallback?: string) {
  let conn = new Connection(rpcPrimary, { commitment: 'processed' });
  return {
    conn,
    async sendSigned(b: Uint8Array) {
      // поддержка VTX и обычных
      try {
        const vtx = VersionedTransaction.deserialize(b);
        const sig = await conn.sendTransaction(vtx, { skipPreflight: false });
        const bh = await conn.getLatestBlockhash();
        await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
        return sig;
      } catch {
        const tx = Transaction.from(b);
        const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
        const bh = await conn.getLatestBlockhash();
        await conn.confirmTransaction({ signature: sig, ...bh }, 'confirmed');
        return sig;
      }
    }
  };
}
