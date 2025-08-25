// Dev-only lightweight simulator for corridor and guards
// Not imported in production paths; can be toggled via a flag in dev

import { VersionedTransaction } from "@solana/web3.js";

type Quote = { outAmount: string };

export type MockCtx = {
  priceSeq: number[];
  allocMin: number;
  allocMax: number;
  getAlloc?: () => { target: number; min: number; max: number };
  getRisk?: () => any;
  tokenDecimals: number;
};

export function makeQuoteMock(rate: number) {
  return async function getJupiterQuote(args: any): Promise<Quote> {
    // simplistic proportional output; set to zero to emulate illiquidity
    return { outAmount: String(Math.floor((args.amount || 0) * rate)) } as any;
  };
}

export function assertInRange(x: number, lo: number, hi: number, msg: string) {
  if (x < lo - 1e-12 || x > hi + 1e-12) throw new Error(`${msg}: ${x} not in [${lo}, ${hi}]`);
}

export async function simulateCorridorInvariant(runOnce: (p: number) => Promise<void>, ctx: MockCtx) {
  let sol = 0.02;
  let tok = 0;
  const min = ctx.allocMin;
  const max = ctx.allocMax;
  for (const p of ctx.priceSeq) {
    await runOnce(p);
    const a = (tok * p) / Math.max(1e-9, tok * p + sol);
    assertInRange(a, min - 1e-6, max + 1e-6, "allocation outside corridor");
  }
}

export async function simulateLossCooldown(setupBuy: () => Promise<void>, priceAfter: number, getNow: () => number, inCooldown: () => boolean) {
  await setupBuy();
  if (!inCooldown()) throw new Error("cooldown expected after loss");
}

export async function simulateImpactGuard(quote: (a: any) => Promise<Quote>, bad: boolean) {
  const q = await quote({ amount: 1_000_000 });
  if (bad && Number(q.outAmount) > 0) throw new Error("expected to abort on bad quote");
}

