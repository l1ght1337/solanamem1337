import { Connection, clusterApiUrl } from '@solana/web3.js';
import { ENV } from './env';

let endpoint =
  ENV.RPC_PRIMARY ||
  clusterApiUrl(ENV.NETWORK === 'mainnet' ? 'mainnet-beta' : 'devnet');

let conn = make(endpoint);

function make(url: string) {
  return new Connection(url, {
    commitment: 'processed',
    confirmTransactionInitialTimeout: 60_000,
  });
}

export function getConnection() {
  return conn;
}

export function getEndpointLabel() {
  return endpoint;
}

export async function checkAndFailover() {
  try {
    // дешёвый health-check
    await conn.getSlot();
  } catch (e) {
    if (ENV.RPC_FALLBACK && ENV.RPC_FALLBACK !== endpoint) {
      endpoint = ENV.RPC_FALLBACK;
      conn = make(endpoint);
      console.warn('[RPC] failover ->', endpoint);
    } else {
      console.warn('[RPC] health-check failed', e);
    }
  }
}
