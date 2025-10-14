// apps/web/src/ui/ScenarioPanel.tsx
import React, { useState } from "react";
import { Connection, SystemProgram, Transaction, LAMPORTS_PER_SOL, PublicKey } from "@solana/web3.js";
import { useStore } from "../store";
import { parseMint as parsePumpMint } from "../utils/pump";
import { getTokenPriceSOL } from "../utils/priceFeed";
import { confirmSigHttp } from "../utils/confirm";

type Props = { connection?: Connection | null };

function rnd(min: number, max: number) {
  return min + Math.random() * Math.max(0, max - min);
}

export function ScenarioPanel({ connection }: Props) {
  const s = useStore();
  const [usdBudget, setUsdBudget] = useState<number>(15000);
  const [noLossBps, setNoLossBps] = useState<number>(10);
  const [mintUrl, setMintUrl] = useState<string>(s.tokenUrl || "");

  // быстрый конвертер USD->SOL по Jupiter (fallback ~130$)
  async function getSolPriceUsd(): Promise<number> {
    try {
      const res = await fetch("https://price.jup.ag/v4/price?ids=So11111111111111111111111111111111111111112&vsToken=USDC", { cache: "no-store" });
      const j = await res.json();
      const usd = Number(j?.data?.So11111111111111111111111111111111111111112?.price);
      return isFinite(usd) && usd > 0 ? usd : 130;
    } catch {
      return 130;
    }
  }

  async function startScenario50() {
    if (!connection) {
      alert("RPC/connection не инициализирован. Проверьте .env и перезапустите dev сервер.");
      return;
    }
    const p = (window as any).solana;
    if (!p?.isPhantom) {
      alert("Подключите Phantom вверху справа");
      return;
    }

    // 1) распознаём mint + дергаем цену токена (для отладки/графика)
    const mint = parsePumpMint(mintUrl);
    if (!mint) { alert("Не удалось распознать mint из Mint/URL"); return; }
    s.setTokenUrl(mintUrl);

    try {
      const ac = new AbortController();
      setTimeout(() => ac.abort(), 5000);
      const res = await getTokenPriceSOL(mint, ac.signal);
      if (res.price && isFinite(res.price)) {
        useStore.setState({ price: res.price });
        s.addLog("ok", `Scenario: token price (${res.source}) ${res.price}`);
      } else {
        s.addLog("warn", "Scenario: price unavailable (это не критично для старта)");
      }
    } catch {}

    // 2) боевые настройки под «много быстрых сделок»
    //   Аллокация: целим 78% в токен, коридор 68..92
    s.setAlloc(0.78, 0.68, 0.92);
    //   Мелкие быстрые срезы
    s.setTradeStep(0.00012, 0.00065, 4, 0.25);
    //   Случайный размер — включаем
    useStore.setState({ useRandomSize: true });
    //   Слиппедж по умолчанию — 60 bps (адаптивный внутри раннера)
    useStore.setState({ slippageBps: 60 });

    //   Параметры «без убытка» и агрессивности на минуту — кладём в риск,
    //   его раннер читает через ctx.getRisk()
    useStore.setState({
      risk: {
        maxImpact: 0.010,
        maxDrawdown: 0.12,
        reserveSol: 0.0035,
        maxNotionalPerMin: 0.010, // ~0.01 SOL/мин на бота
        maxBuysPerMin: 5,
        maxSellsPerMin: 9,
        lossThrPct: 0.003,
        lossWindowMs: 30000,
        lossCooldownMs: 120000,
        maxBuySliceSol: 0.00055,
        maxSellSliceTokPct: 0.12,
        minSliceGapMs: 220,
        maxSliceGapMs: 900,
        noLossFloorBps: Math.max(0, Number(noLossBps) || 0),
      }
    } as any);

    // 3) создаём 50 ботов и распределяем роли
    const N = 50;
    const roles = [
      ...Array(18).fill("scalper"),
      ...Array(12).fill("maker"),
      ...Array(10).fill("momentum"),
      ...Array(7).fill("revert"),
      ...Array(3).fill("trend"),
    ] as Array<"trend"|"revert"|"scalper"|"momentum"|"range"|"maker">;

    // порядок перемешаем, чтобы скорости/профили чередовались
    roles.sort(() => Math.random() - 0.5);

    // создаём пачку
    for (let i = 0; i < N; i++) {
      s.addBot();
      // дождёмся, пока bot попадёт в store
      await new Promise((r) => setTimeout(r, 0));
      const bot = useStore.getState().bots.at(-1);
      if (!bot) continue;
      const strat = roles[i % roles.length] as any;
      const speed = Math.round(rnd(650, 1400)); // 0.65..1.4 сек
      // budgetSol — верхний лимит размера, это не пополнение кошелька!
      s.updateBot(bot.id, {
        name: `Bot#${i+1}`,
        strategy: strat,
        budgetSol: 0.25, // ограничитель «жадности» одного шага
        speedMs: speed,
        aiEnabled: true,
        last: "scenario",
      } as any);
    }

    // 4) стартуем всех
    await s.startAll(connection);

    // 5) (опционально) первая разгонная покупка — если SOL на ботах уже есть.
    //    Иначе используйте блок FUND ниже.
    try {
      await s.buyAllBots80OnPump(connection);
    } catch {}

    s.addLog("ok", `Scenario Pump x50: создано и запущено ${N} ботов`);
  }

  // полезный помощник: равномерно профинансировать ботов с USD-бюджета
  async function fundFromWalletEqually() {
    if (!connection) { alert("Нет connection"); return; }
    const p = (window as any).solana;
    if (!p?.isPhantom) { alert("Подключите Phantom"); return; }
    const from = new PublicKey(p.publicKey?.toString());
    const bots = useStore.getState().bots;
    if (!bots.length) { alert("Нет ботов"); return; }
    if (usdBudget <= 0) { alert("Укажите бюджет в USD"); return; }
    const usdPerBot = usdBudget / bots.length;
    const solUsd = await getSolPriceUsd();
    const solPerBot = usdPerBot / solUsd;

    for (let i = 0; i < bots.length; i++) {
      const to = new PublicKey(bots[i].pubkey);
      const lamports = Math.ceil(solPerBot * LAMPORTS_PER_SOL);
      try {
        const ix = SystemProgram.transfer({ fromPubkey: from, toPubkey: to, lamports });
        const tx = new Transaction().add(ix);
        tx.feePayer = from;
        tx.recentBlockhash = (await connection.getLatestBlockhash()).blockhash;
        const signed = await p.signTransaction(tx);
        const sig = await connection.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 });
        await confirmSigHttp(connection, sig);
        useStore.getState().addLog("ok", `Fund → ${bots[i].name}: ${(lamports/LAMPORTS_PER_SOL).toFixed(6)} SOL (${sig.slice(0,8)}…)`);
      } catch (e: any) {
        useStore.getState().addLog("err", `Fund error ${bots[i].name}: ${e?.message || e}`);
      }
      // чтобы не ловить лимиты — выдержим небольшую паузу
      if (i < bots.length - 1) await new Promise((r) => setTimeout(r, 1200));
    }
  }

  return (
    <div style={{ padding: 8, border: "1px solid #283042", borderRadius: 10, background: "#0f1325", marginBottom: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap" }}>
      <span style={{ fontWeight: 700 }}>📈 Сценарий: Pump x50</span>
      <span>Бюджет, USD:</span>
      <input value={usdBudget} onChange={e => setUsdBudget(Number(e.target.value) || 0)} style={input} />
      <span>No-loss floor, bps:</span>
      <input value={noLossBps} onChange={e => setNoLossBps(Number(e.target.value) || 0)} style={input} />
      <span>Mint/URL:</span>
      <input value={mintUrl} onChange={e => setMintUrl(e.target.value)} style={{ ...input, width: 520 }} />
      <button onClick={startScenario50} style={btn}>Старт (50 ботов)</button>
      <button onClick={fundFromWalletEqually} style={btnSm}>Fund по USD</button>
    </div>
  );
}

const input: React.CSSProperties = {
  width: 120, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px"
};
const btn: React.CSSProperties = { background: "#1b5cff", color: "#fff", borderRadius: 8, padding: "8px 12px", cursor: "pointer", border: "1px solid #1b5cff" };
const btnSm: React.CSSProperties = { ...btn, padding: "6px 10px" };
