export type Strategy = 'trend' | 'revert' | 'scalper';

export type BotConfig = {
  id: string;
  name: string;
  pubkey: string;
  secretEnc: string;  // ЗАШИФРОВАННЫЙ base64(secretKey)
  running: boolean;
  speedMs: number;
  budgetSol: number;
  strategy: Strategy;
  slippageBps: number;
  mint: string;             // токен, с которым торгует бот
  twap?: { slices: number; gapMs: number } | null;
};

export type BotStatus = {
  id: string;
  name: string;
  pubkey: string;
  running: boolean;
  last?: string;
  lastError?: string;
  fills: number;
  realized: number;
  unrealized: number;
  posToken: number;
  avgSol: number;
  price?: number;
};

export type ApiResponse<T> = { ok: true; data: T } | { ok: false; error: string };
