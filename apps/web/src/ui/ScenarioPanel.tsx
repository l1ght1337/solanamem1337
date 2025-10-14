// apps/web/src/ui/ScenarioPanel.tsx
import React, { useRef, useState } from "react";
import { Connection } from "@solana/web3.js";
import { useStore } from "../store";
import { parseMint as parsePumpMint } from "../utils/pump";
import { getTokenPriceSOL } from "../utils/priceFeed";

type Props = { connection?: Connection | null };

export function ScenarioPanel({ connection }: Props) {
  const s = useStore();
  const [mintUrl, setMintUrl] = useState<string>(s.tokenUrl || "");
  const [noLossBps, setNoLossBps] = useState<number>(12); // 0.12% по умолчанию
  const [slippageBps, setSlippageBps] = useState<number>(60);
  const runningRef = useRef(false);

  const ensure = () => {
    if (!connection) { alert("RPC/connection не инициализирован"); return false; }
    if (!(window as any).solana?.isPhantom) { alert("Подключите Phantom"); return false; }
    const mint = parsePumpMint(mintUrl);
    if (!mint) { alert("Не распознан Mint/URL токена"); return false; }
    s.setTokenUrl(mintUrl);
    return true;
  };

  async function applySettings() {
    if (!ensure()) return;

    // Пробуем подтянуть цену (чтобы заполнился график/лог).
    try {
      const mint = parsePumpMint(mintUrl)!;
      const ac = new AbortController(); setTimeout(() => ac.abort(), 2500);
      const res = await getTokenPriceSOL(mint, ac.signal);
      if (res.price && isFinite(res.price)) {
        useStore.setState({ price: res.price, tokenMint: mint });
        s.addLog("ok", `Price (${res.source}) = ${res.price}`);
      }
    } catch {}

    // Агрессивный профиль под «много сделок»
    s.setAlloc(0.74, 0.64, 0.90);                       // target/min/max
    s.setTradeStep(0.00008, 0.00055, 4, 0.25);          // min/max, slices, jitter
    useStore.setState({ useRandomSize: true, slippageBps });

    // Риск‑профиль + no-loss floor
    useStore.setState({
      risk: {
        maxImpact: 0.010,         // ≤1.0% на срез
        maxDrawdown: 0.12,
        reserveSol: 0.0010,       // ↓ резерв, чтобы начинать покупки даже на мелких балансах
        maxNotionalPerMin: 0.020, // суммарный объём покупок в SOL/мин
        maxBuysPerMin: 8,
        maxSellsPerMin: 12,
        lossThrPct: 0.003,
        lossWindowMs: 30000,
        lossCooldownMs: 120000,
        maxBuySliceSol: 0.00055,
        maxSellSliceTokPct: 0.12,
        minSliceGapMs: 180,
        maxSliceGapMs: 900,
        noLossFloorBps: Math.max(0, Number(noLossBps) || 0), // продажи не ниже avg*(1+floor), кроме служебных
      }
    } as any);

    s.addLog("ok", "Scenario settings applied");
  }

  async function startRunners() {
    if (!ensure()) return;
    await s.startAll(connection!);
    runningRef.current = true;
    s.addLog("ok", "All bots started");
  }

  // Одноразовый «разгон»: direct‑маршрут покупки на ~80% остатка SOL для каждого бота
  async function primeBuy() {
    if (!ensure()) return;
    await s.refreshBalances(connection!);
    await s.buyAllBots80OnPump(connection!); // использует fast‑роут, не зависит от коридора раннера
    s.addLog("ok", "Prime buy done (≈80% от текущего SOL)");
  }

  async function runAll() {
    await applySettings();
    await startRunners();
    await primeBuy();
  }

  async function stopRunners() {
    useStore.getState().stopAll();
    runningRef.current = false;
    s.addLog("ok", "All bots stopped");
  }

  return (
    <div style={wrap}>
      <span style={{ fontWeight: 700 }}>📈 Сценарий: Pump (для уже созданных ботов)</span>
      <span>Mint/URL:</span>
      <input value={mintUrl} onChange={(e) => setMintUrl(e.target.value)} style={inputWide} />

      <span>No‑loss floor, bps:</span>
      <input type="number" value={noLossBps} min={0} max={40} onChange={(e) => setNoLossBps(+e.target.value || 0)} style={input} />

      <span>Slippage, bps:</span>
      <input type="number" value={slippageBps} min={10} max={140} onChange={(e) => setSlippageBps(+e.target.value || 0)} style={input} />

      <button onClick={applySettings} style={btn}>Apply</button>
      <button onClick={startRunners} style={btn}>Start runners</button>
      <button onClick={primeBuy} style={btn}>Prime buy (80%)</button>
      <button onClick={runAll} style={btnAccent}>Run (Apply + Start + Prime)</button>
      <button onClick={stopRunners} style={btnDanger}>Stop runners</button>
    </div>
  );
}

const wrap: React.CSSProperties = {
  padding: 8, border: "1px solid #283042", borderRadius: 10, background: "#0f1325",
  marginBottom: 10, display: "flex", gap: 10, alignItems: "center", flexWrap: "wrap"
};
const input: React.CSSProperties = { width: 110, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" };
const inputWide: React.CSSProperties = { ...input, width: 450 };
const btn: React.CSSProperties = { background: "#1b5cff", color: "#fff", borderRadius: 8, padding: "6px 10px", cursor: "pointer", border: "1px solid #1b5cff" };
const btnAccent: React.CSSProperties = { ...btn, background: "#2563eb", borderColor: "#2563eb" };
const btnDanger: React.CSSProperties = { ...btn, background: "#e25454", borderColor: "#e25454" };
