import { Keypair, VersionedTransaction } from '@solana/web3.js';
import { getConn } from './solana';
import { Buffer } from 'buffer';
(globalThis as any).Buffer ||= Buffer;

export async function buildTradeTx(pumpBase: string, body: Record<string, any>) {
  const url = `${pumpBase.replace(/\/$/,'')}/api/trade-local`;
  const r = await fetch(url, {
    method: 'POST',
    headers: { 'content-type':'application/json' },
    body: JSON.stringify(body)
  });
  if (!r.ok) throw new Error(`pump ${r.status}: ${await r.text()}`);
  const raw = new Uint8Array(await r.arrayBuffer());
  return VersionedTransaction.deserialize(raw);
}

export async function serverTrade(params: {
  rpcPrimary: string, rpcFallback?: string,
  pumpBase: string,
  wallet: Keypair,
  action: 'buy'|'sell',
  mint: string,
  amountSolUi: number,
  slippageBps: number
}) {
  const { rpcPrimary, rpcFallback, pumpBase, wallet, action, mint, amountSolUi, slippageBps } = params;

  const vtx = await buildTradeTx(pumpBase, {
    publicKey: wallet.publicKey.toBase58(),
    action,
    mint,
    denominatedInSol: 'true',
    amount: Number(amountSolUi.toFixed(9)),
    slippage: Math.max(0, slippageBps) / 100,  // bps → %
    priorityFee: 0.00001,
    pool: 'auto',
  });
  vtx.sign([wallet]);

  const { sendSigned } = getConn(rpcPrimary, rpcFallback);
  const sig = await sendSigned(vtx.serialize());
  return sig;
}
