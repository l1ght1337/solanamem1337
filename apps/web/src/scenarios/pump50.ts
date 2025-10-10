// apps/web/src/scenarios/pump50.ts
import { Connection } from "@solana/web3.js";
import { useStore } from "../store";
import { getJupiterQuote, WSOL } from "../utils/jupiter";

const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

async function getSolUsd(): Promise<number> {
  try {
    const q = await getJupiterQuote({ inputMint: WSOL, outputMint: USDC, amount: 1_000_000_000 }); // 1 SOL
    const usd = Number(q?.outAmount || 0) / 1_000_000;
    return usd > 0 ? usd : 150;
  } catch { return 150; }
}

export async function applyPump50Scenario(connection: Connection, opts?: { totalUsd?: number; noLossFloorBps?: number; tokenUrlOrMint?: string }) {
  const totalUsd = Math.max(1, Math.floor(opts?.totalUsd ?? 15000));
  const st = useStore.getState();

  // 1) Аллокации и исполнение
  st.setAlloc(0.72, 0.58, 0.86);
  st.smartMM = { enabled: true, minBps: 40, maxBps: 160, alpha: 0.55, twapSec: 180, twapSlices: 5 };
  st.setTradeStep(0.00025, 0.0012, 5, 0.22);
  // усилить лимиты
  const baseRisk = st.getRisk();
  (useStore.getState() as any).getRisk = () => ({
    ...baseRisk,
    maxImpact: 0.022,
    maxNotionalPerMin: 0.006,
    maxBuysPerMin: 4,
    maxSellsPerMin: 8,
    maxBuySliceSol: 0.0009,
    maxSellSliceTokPct: 0.14,
    minSliceGapMs: 450,
    maxSliceGapMs: 1200,
    noLossFloorBps: Math.max(0, Math.floor(opts?.noLossFloorBps ?? 10)), // по умолчанию 0.10% над средней
  });

  // 2) Боты
  const need = 50;
  while (useStore.getState().bots.length < need) useStore.getState().addBot();

  const bots = useStore.getState().bots.slice(0, need);
  const solUsd = await getSolUsd();
  const totalSol = totalUsd / solUsd;

  // распределим бюджеты с разбросом
  const weights: Array<{ strat: "trend"|"momentum"|"revert"|"scalper"|"range"|"maker"; share: number; speed: [number, number]; }> = [
    { strat: "trend",    share: 0.28, speed: [4200, 6500] },
    { strat: "momentum", share: 0.22, speed: [3200, 5200] },
    { strat: "scalper",  share: 0.18, speed: [1200, 2200] },
    { strat: "revert",   share: 0.16, speed: [7800, 9600] },
    { strat: "range",    share: 0.10, speed: [6200, 8400] },
    { strat: "maker",    share: 0.06, speed: [1500, 2300] },
  ];
  const perBotAvgSol = totalSol / need;

  let idx = 0;
  for (const w of weights) {
    const cnt = Math.max(1, Math.round(w.share * need));
    for (let k = 0; k < cnt && idx < bots.length; k++, idx++) {
      const b = bots[idx];
      const budget = perBotAvgSol * (0.75 + Math.random() * 0.5); // ±25%
      const speed  = Math.round(w.speed[0] + Math.random() * (w.speed[1] - w.speed[0]));
      useStore.getState().updateBot(b.id, {
        strategy: w.strat as any,
        budgetSol: +budget.toFixed(6),
        speedMs: speed,
        aiEnabled: true,
        manualLock: false,
      });
    }
  }

  // 3) Токен
  if (opts?.tokenUrlOrMint) {
    st.setTokenUrl(opts.tokenUrlOrMint);
  }

  // 4) Warm‑up + баланс + старт
  try { await st.safeWarmupBots(connection); } catch {}
  await st.refreshBalances(connection);
  st.startAll(connection);

  // экспорт шортката в окно браузера
  (window as any).__scenarioPump50 = { totalUsd, solUsd, totalSol, perBotAvgSol };
}
