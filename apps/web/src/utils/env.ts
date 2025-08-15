export const ENV = {
  RPC_PRIMARY: (import.meta.env.VITE_RPC_PRIMARY ?? '').trim(),
  RPC_FALLBACK: (import.meta.env.VITE_RPC_FALLBACK ?? '').trim(),
  NETWORK: ((import.meta.env.VITE_NETWORK ?? 'mainnet').trim() ||
    'mainnet') as 'mainnet' | 'devnet',
};

export const isRpcSet = !!ENV.RPC_PRIMARY;
