// apps/web/src/scenarios/pump50.ts
import { useStore } from "../store";
import { getJupiterQuote, WSOL } from "../utils/jupiter";
import { parseMint as parsePumpMint } from "../utils/pump";

const USDC = "EPjFWdd5AufqSSqeM2q65uxQ52fQSQhxxkNFiWgj2KB"; // canonical USDC

type ScenarioOpts = {
  totalUsd?: number;           // суммарный бюджет в USD (по умолчанию 15000)
  botsCount?: number;          // по умолчанию 50
  noLossFloorBps?: number;     // 0..∞ — обычные продажи ниже средней запрещены (исключая микросейлы для fee)
  tokenUrlOrMint?: string;     // pump.fun URL или mint
  scalpersOnly?: boolean;      // если true — все стратегии = scalper
  aggro?: boolean;             // агрессивные лимиты (много сделок)
};

async function solUsd(): Promise<number> {
  try {
    const q = await getJupiterQuote({ inputMint: WSOL, outputMint: USDC, amount: 1_000_000_000 }); // 1 SOL
    const usdc = Number(q?.outAmount || 0) / 1e6;
    if (usdc > 0.1 && isFinite(usdc)) return usdc;
  } catch {}
  return 150; // фолбэк-курс
}

function pick<T>(arr: T[], i: number) { return arr[i % arr.length]; }

export async function applyPump50Scenario(connection: any, opts: ScenarioOpts = {}) {
  const s = useStore.getState();

  const totalUsd = Math.max(1000, Math.round((opts.totalUsd ?? 15000)));
  const botsCount = Math.max(5, Math.min(100, Math.round(opts.botsCount ?? 50)));
  const aggro = opts.aggro !== false;

  // ── Токен
  let mint = opts.tokenUrlOrMint ? parsePumpMint(opts.tokenUrlOrMint) : (s.tokenMint || parsePumpMint(s.tokenUrl));
  if (!mint && opts.tokenUrlOrMint && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(opts.tokenUrlOrMint)) {
    mint = opts.tokenUrlOrMint;
  }
  if (!mint) {
    // записываем URL, чтобы график и price‑feed подтянулись сразу после ввода
    if (opts.tokenUrlOrMint) s.setTokenUrl(opts.tokenUrlOrMint);
  } else {
    s.setTokenUrl(`https://pump.fun/coin/${mint}`);
  }

  // ── Глобальные настройки исполнения
  s.setAlloc(0.78, 0.58, 0.86);                 // вкачиваем позицию в начале
  s.setTradeStep(0.00020, 0.00120, 4, 0.30);    // мелкие срезы, джиттер 30%
  useStore.setState({ slippageBps: 85 });       // выше в памп‑фазе

  // Агрессивные лимиты (много сделок в минуту, но с контролем импакта)
  const baseRisk = {
    maxImpact: 0.012,          // 1.2% максимум импакта на СРЕЗ
    maxDrawdown: 0.18,         // защитный режим после −18%
    reserveSol: 0.0060,        // резерв на комиссии
    maxNotionalPerMin: aggro ? 0.012 : 0.006, // суммарные покупки в SOL/мин
    maxBuysPerMin:    aggro ? 12 : 6,
    maxSellsPerMin:   aggro ? 18 : 10,
    lossThrPct: 0.004,         // при падении после покупки ≥0.4% → cooldown
    lossWindowMs: 25_000,
    lossCooldownMs: 120_000,
    maxBuySliceSol: aggro ? 0.0014 : 0.0008,
    maxSellSliceTokPct: aggro ? 0.20   : 0.12,
    minSliceGapMs: aggro ? 250 : 600,
    maxSliceGapMs: aggro ? 700 : 1_800,
  };

  // no‑loss floor — возвращаем динамическую функцию риска с порогом
  const noLossFloorBps = Math.max(0, Math.round(opts.noLossFloorBps ?? 10)); // 0.10%
  const _getRisk = () => ({ ...baseRisk, noLossFloorBps });
  // Мягкая интеграция: если в сторе есть setRisk — используем, иначе подменяем getRisk
  (useStore.getState() as any).getRisk = _getRisk;

  // ── Создаём / доводим число ботов
  while (useStore.getState().bots.length < botsCount) {
    useStore.getState().addBot();
  }
  if (useStore.getState().bots.length > botsCount) {
    // лишних не удаляем автоматически — это осознанное действие
  }

  // ── Распределяем роли, скоростя, бюджеты
  const roleMix = opts.scalpersOnly
    ? Array.from({ length: botsCount }, () => "scalper" as const)
    : [
        "scalper","scalper","scalper","scalper","scalper","scalper","scalper","scalper","scalper","scalper",
        "momentum","momentum","momentum","momentum","momentum","momentum","trend","trend","trend","trend",
        "revert","revert","revert","range","range","maker","maker","maker",
        // остаток — чередуем:
      ] as any[];

  const bots = useStore.getState().bots;
  const priceSOL = await solUsd();
  const totalSol = totalUsd / priceSOL;
  const perBotSol = totalSol / botsCount;

  // небольшой разброс бюджета / скорости, чтобы фазы не били синфазно
  const jitter = (x: number, p: number) => Math.max(0, x * (1 + (Math.random()*2-1)*p));

  bots.slice(0, botsCount).forEach((b, i) => {
    const strat = pick(roleMix, i) as any;
    const speedMs =
      strat === "scalper"  ? Math.floor(jitter(420 + Math.random()*260, 0.18)) :
      strat === "momentum" ? Math.floor(jitter(520 + Math.random()*280, 0.18)) :
      strat === "trend"    ? Math.floor(jitter(680 + Math.random()*320, 0.18)) :
      strat === "maker"    ? Math.floor(jitter(560 + Math.random()*260, 0.18)) :
                             Math.floor(jitter(720 + Math.random()*320, 0.18)); // revert/range

    const budgetSol = +(jitter(perBotSol, 0.12)).toFixed(4);
    useStore.getState().updateBot(b.id, {
      strategy: strat,
      speedMs,
      budgetSol,
      aiEnabled: true,
    });
  });

  // ── Плавный переход из пампа в «ровный» режим через 2–3 минуты
  setTimeout(() => {
    try {
      useStore.getState().setAlloc(0.72, 0.60, 0.86);
      useStore.setState({ slippageBps: 60 });
    } catch {}
  }, 140_000 + Math.floor(Math.random()*40_000));

  // ── Выставляем токен, если его распознали
  if (mint) {
    useStore.getState().setTokenUrl(`https://pump.fun/coin/${mint}`);
  }

  // ── Синхронизируем балансы и стартуем
  await useStore.getState().refreshBalances(connection);
  await useStore.getState().startAll(connection);

  // метаданные в window для быстрых проверок/долива
  (window as any).__scenarioPump50 = {
    totalUsd, priceSOL, totalSol, perBotSol, botsCount, aggro, noLossFloorBps,
  };
}
