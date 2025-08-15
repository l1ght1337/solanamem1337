// src/solana/connection.ts
import { Connection } from '@solana/web3.js';
import { ENV } from '../utils/env';

let primary: Connection | null = null;
let fallback: Connection | null = null;

export function getConnection(preferFallback = false): Connection {
  if (preferFallback) {
    if (!fallback) fallback = new Connection(ENV.RPC_FALLBACK || ENV.RPC_URL || '', 'confirmed');
    return fallback;
  }
  if (!primary) {
    if (!ENV.RPC_URL) console.warn('RPC не задан в .env (VITE_RPC_URL)');
    primary = new Connection(ENV.RPC_URL || ENV.RPC_FALLBACK || '', 'confirmed');
  }
  return primary;
}
