// src/utils/wallet.ts
import { PublicKey } from '@solana/web3.js';

type PhantomProvider = {
  isPhantom?: boolean;
  connect: (opts?: { onlyIfTrusted: boolean }) => Promise<{ publicKey: PublicKey }>;
  disconnect: () => Promise<void>;
  on: (event: string, handler: (...args: any[]) => void) => void;
  request?: (args: any) => Promise<any>;
  publicKey?: PublicKey;
};

export function getProvider(): PhantomProvider | null {
  const anyWindow = window as any;
  if ('solana' in anyWindow) {
    const p = anyWindow.solana as PhantomProvider;
    if (p?.isPhantom) return p;
  }
  return null;
}

export async function connectPhantom(): Promise<PublicKey | null> {
  const provider = getProvider();
  if (!provider) {
    alert('Phantom не найден. Установи расширение Phantom Wallet.');
    return null;
  }
  try {
    const res = await provider.connect();
    return res?.publicKey ?? null;
  } catch (e) {
    console.error('Phantom connect error:', e);
    return null;
  }
}

export async function disconnectPhantom() {
  const provider = getProvider();
  try {
    await provider?.disconnect?.();
  } catch (e) {
    console.error('Phantom disconnect error:', e);
  }
}

export function shortPk(pk?: PublicKey | string, left = 4, right = 4) {
  if (!pk) return '';
  const b58 = typeof pk === 'string' ? pk : pk.toBase58();
  if (b58.length <= left + right) return b58;
  return `${b58.slice(0, left)}…${b58.slice(-right)}`;
}
