import { Connection, PublicKey } from '@solana/web3.js';

export async function getMintDecimals(_c: Connection, _mint: string): Promise<number> {
  // при желании включи реальное чтение mint
  return 9;
}

export async function getSPLBalance(_c: Connection, _owner: string, _mint: string): Promise<bigint> {
  // stub (замени на реальную getTokenAccountsByOwner при необходимости)
  return 0n;
}
