import { Connection } from '@solana/web3.js';
import { ENV } from '../utils/env';

let primary: Connection | null = null;
let fallback: Connection | null = null;

export function getConnection(preferFallback = false): Connection {
  if (preferFallback) {
    if (!fallback) fallback = new Connection(ENV.RPC_FALLBACK || ENV.RPC_PRIMARY || '', 'confirmed');
    return fallback;
  }
  if (!primary) {
    if (!ENV.RPC_PRIMARY) console.warn('RPC не задан в .env (VITE_RPC_PRIMARY)');
    primary = new Connection(ENV.RPC_PRIMARY || ENV.RPC_FALLBACK || '', 'confirmed');
  }
  return primary;
}
