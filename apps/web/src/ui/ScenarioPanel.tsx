// apps/web/src/ui/ScenarioPanel.tsx
import React, { useState } from "react";
import { useStore } from "../store";
import { applyPump50Scenario } from "../scenarios/pump50";

export function ScenarioPanel() {
  const [usd, setUsd] = useState(15000);
  const [floor, setFloor] = useState(10);
  const [mint, setMint] = useState("");
  const start = async () => {
    const conn = (window as any).__conn;
    if (!conn) { alert("Нет Connection (__conn)"); return; }
    await applyPump50Scenario(conn, {
      totalUsd: usd,
      noLossFloorBps: floor,
      tokenUrlOrMint: mint.trim() || undefined,
    });
  };
  return (
    <div style={{ padding: 12, border: "1px solid #333", borderRadius: 8, marginBottom: 12 }}>
      <div style={{ fontWeight: 600, marginBottom: 8 }}>🚀 Сценарий: Pump x50</div>
      <div style={{ display: "flex", gap: 12, alignItems: "center", flexWrap: "wrap" }}>
        <label>Бюджет, USD:
          <input type="number" value={usd} onChange={e => setUsd(+e.target.value)} style={{ width: 120, marginLeft: 6 }} />
        </label>
        <label>No‑loss floor, bps:
          <input type="number" value={floor} onChange={e => setFloor(+e.target.value)} style={{ width: 80, marginLeft: 6 }} />
        </label>
        <label>Mint/URL:
          <input type="text" placeholder="опционально" value={mint} onChange={e => setMint(e.target.value)} style={{ width: 320, marginLeft: 6 }} />
        </label>
        <button onClick={start} style={{ padding: "8px 14px", fontWeight: 600 }}>Старт (50 ботов)</button>
      </div>
    </div>
  );
}
