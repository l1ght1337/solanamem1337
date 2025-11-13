
// apps/web/src/App.tsx
import "./polyfills"; // <— важно: полифилл до всего остального

import React, { useEffect, useMemo, useState } from "react";
import { useStore } from "./store";
import { confirmSigHttp } from "./utils/confirm";
import { Connection, LAMPORTS_PER_SOL, PublicKey, SystemProgram, Transaction } from "@solana/web3.js";
import CandleTV from "./components/CandleTV";
import { getNetMetrics } from "./utils/network";
import { getTxTelemetry } from "./utils/tx";
import { getActiveConnection, getActiveRpcUrl, getRpcTelemetry, healthcheckAndMaybeFailover } from "./utils/connection";
import { logger } from "./utils/logger";
import { getTokenPriceSOL } from "./utils/priceFeed";
import { parseMint as parsePumpMint } from "./utils/pump";
import { parseLocaleNumber, safeParseNumber, toFixedOrZero } from "./utils/number";

declare global {
  interface Window {
    solana?: any;
  }
}

export default function App() {
  const s = useStore();

  // Smart RPC: primary + fallbacks with health-based failover
  const [activeRpcUrl, setActiveRpcUrl] = useState<string>(() => getActiveRpcUrl());
  const connection = useMemo(() => getActiveConnection(), [activeRpcUrl]);

  // RPC status for header
  const [rpcOk, setRpcOk] = useState<boolean | null>(null);
  const rpcHost = useMemo(() => {
    try { return activeRpcUrl ? new URL(activeRpcUrl).host : ""; } catch { return activeRpcUrl || ""; }
  }, [activeRpcUrl]);
  useEffect(() => {
    let stop = false;
    // expose connection globally for light refreshes
    (window as any).__conn = connection;
    const check = async () => {
      try {
        logger.info("Boot: checking RPC health…");
        await healthcheckAndMaybeFailover();
        if (!stop) {
          setRpcOk(true);
          const url = getActiveRpcUrl();
          if (url && url !== activeRpcUrl) setActiveRpcUrl(url);
        }
      } catch {
        if (!stop) setRpcOk(false);
      }
    };
    check();
    const id = setInterval(check, 15000);
    return () => { stop = true; clearInterval(id); };
  }, [connection, activeRpcUrl]);

  // авто-тикеры — чаще для цены
  useEffect(() => {
    if (!connection) return;
    const id = setInterval(() => s.tickReal(), 2_000);
    const id2 = setInterval(() => s.refreshBalances(connection), 3_000);
    return () => {
      clearInterval(id);
      clearInterval(id2);
    };
  }, [connection, s]);

  // Phantom
  const [walletPubkey, setWalletPubkey] = useState<string>("");
  const connectWallet = async () => {
    const p = window.solana;
    if (!p || !p.isPhantom) {
      logger.warn("Phantom not detected");
      alert("Установите Phantom");
      return;
    }
    const res = await p.connect();
    setWalletPubkey(res.publicKey?.toString() || "");
  };
  const disconnectWallet = async () => {
    try {
      await window.solana?.disconnect();
    } catch {}
    setWalletPubkey("");
  };

  const ensureConnection = () => {
    if (!connection) {
      alert("RPC не задан в .env (VITE_*). Перезапустите dev-сервер после правок .env.");
      return false;
    }
    return true;
  };

  // Массовое пополнение из кошелька
  const [fundTotal, setFundTotal] = useState<number>(0);
  const [warmAfterFund, setWarmAfterFund] = useState<boolean>(true);

  const fundAllEqually = async () => {
    if (!ensureConnection()) return;
    if (!walletPubkey) {
      alert("Подключите кошелёк");
      return;
    }
    const bots = s.bots;
    if (bots.length === 0) {
      alert("Нет ботов");
      return;
    }
    if (fundTotal <= 0) {
      alert("Введите сумму");
      return;
    }

    const perBot = fundTotal / bots.length;
    const fromPk = new PublicKey(walletPubkey);

    for (let i = 0; i < bots.length; i++) {
      const b = bots[i];
      const toPk = new PublicKey(b.pubkey);
      const lamports = Math.ceil(perBot * LAMPORTS_PER_SOL);

      try {
        const ix = SystemProgram.transfer({ fromPubkey: fromPk, toPubkey: toPk, lamports });
        const tx = new Transaction().add(ix);
        tx.feePayer = fromPk;
        tx.recentBlockhash = (await connection!.getLatestBlockhash()).blockhash;
        const signed = await window.solana.signTransaction(tx);
        const sig = await connection!.sendRawTransaction(signed.serialize(), { skipPreflight: true, maxRetries: 3 });
        await confirmSigHttp(connection!, sig);
        s.addLog("ok", `Funded ${b.name}: ${perBot.toFixed(6)} SOL (${sig})`);
      } catch (e: any) {
        s.addLog("err", `Funding error ${b.name}: ${e?.message || e}`);
      }

      if (i < bots.length - 1) await new Promise((r) => setTimeout(r, 30_000));
    }
    await s.refreshBalances(connection!);

    // автозапуск mainnet warm-up после пополнения (по чекбоксу)
    if (warmAfterFund) {
      await s.mainnetWarmupTransfers(connection!, { txPerBot: 30, lamports: 5_000, gapMs: 1200 });
    }
  };

  const startBot = async (bId: string) => {
    if (!ensureConnection()) return;
    await s.startBot(bId, connection!);
  };

  // MAINNET warm-up ручной запуск
  const mainnetWarm = async () => {
    if (!ensureConnection()) return;
    await s.mainnetWarmupTransfers(connection!, { txPerBot: 30, lamports: 5_000, gapMs: 1200 });
  };

  // Drain UI
  const [drainTo, setDrainTo] = useState<"wallet" | "treasury">("wallet");
  const drainAll = async () => {
    if (!ensureConnection()) return;
    let dest = "";
    if (drainTo === "wallet") {
      if (!walletPubkey) {
        alert("Подключите кошелёк");
        return;
      }
      dest = walletPubkey;
    } else {
      const id = useStore.getState().treasuryKeyId;
      if (!id) {
        alert("Treasury не задан");
        return;
      }
      try {
        const { getKeypair } = await import("./utils/keyring");
        const kp = getKeypair(id);
        if (!kp) { alert("Нет ключа Treasury"); return; }
        dest = kp.publicKey.toBase58();
      } catch {
        alert("Не удалось получить адрес Treasury");
        return;
      }
    }
    await s.drainAllTo(connection!, dest);
  };

  // ===== Create on Pump.fun (новое) =====
  const [cName, setCName] = useState("MyCoin");
  const [cSymbol, setCSymbol] = useState("MYC");
  const [cImage, setCImage] = useState("https://i.imgur.com/your.png");
  const [cDesc, setCDesc] = useState("");
  const [cDec, setCDec] = useState<number>(6);
  const [cInitialBuy, setCInitialBuy] = useState<number>(0.02);

  const createPump = async () => {
    if (!ensureConnection()) return;
    if (!walletPubkey) {
      alert("Подключите Phantom — создание токена подписывается вашим кошельком");
      return;
    }
    await s.createPumpToken(connection!, walletPubkey, {
      name: cName.trim(),
      symbol: cSymbol.trim(),
      image: cImage.trim(),
      description: cDesc.trim(),
      decimals: cDec || 6,
      initialBuySol: cInitialBuy || 0,
    });
  };

  return (
    <div style={{ padding: 16, color: "#e2e8f0", background: "#0b0e1a", minHeight: "100vh" }}>
      {/* Header */}
      <div style={header}>
        <div style={{ display: "flex", gap: 12, alignItems: "baseline", flexWrap: "wrap" }}>
          <div style={{ fontWeight: 700, fontSize: 18 }}>Solana Meme Bundler — Real</div>
          <div>
            Price <b>{s.price.toFixed(9)}</b> | Equity{" "}
            <b>{s.bots.reduce((a, b) => a + b.solBalance, 0).toFixed(3)} SOL</b>
          </div>
          {!activeRpcUrl && <span style={{ color: "#ffb86c" }}>RPC не задан в .env</span>}
          {activeRpcUrl && (
            <span style={{ color: rpcOk ? "#8aff8a" : rpcOk === false ? "#ff6b6b" : "#97a6ba", fontSize: 12 }}>
              RPC {rpcHost} {rpcOk === null ? "…" : rpcOk ? "ok" : "fail"}
              {" · p95Tx "}{getTxTelemetry().p95_ms}{" ms"}
              {" · p95Confirm "}{getRpcTelemetry().p95ConfirmMs}{" ms"}
              {" · failRate "}{(getRpcTelemetry() as any).failRate?.toFixed?.(2)}
              {" · cu≥"}{Number((import.meta.env as any).VITE_PRIORITY_FEE_MIN ?? 1000)}{"µ/CU"}
              {" · pf≥"}{Number((import.meta.env as any).VITE_PRIORITY_FEE_BASE ?? 0.000015)}{" SOL"}
            </span>
          )}
        </div>
        <div>
          {!walletPubkey ? (
            <button onClick={connectWallet} style={btn}>
              Connect Phantom
            </button>
          ) : (
            <div style={{ display: "flex", gap: 8, alignItems: "center" }}>
              <span>
                Wallet: {walletPubkey.slice(0, 4)}…{walletPubkey.slice(-4)}
              </span>
              <button onClick={disconnectWallet} style={btnSm}>
                Disconnect
              </button>
            </div>
          )}
        </div>
      </div>

      {/* Панель */}
      <div style={{ marginTop: 12, padding: 12, border: "1px solid #283042", borderRadius: 10, background: "#0f1325" }}>
        <div style={{ display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" }}>
          {/* лёгкий статус сети (без изменения стилей кнопок) */}
          <span style={{ color: "#97a6ba", fontSize: 12 }}>
            net: rps {getNetMetrics().rps} | q {getNetMetrics().queued} | in {getNetMetrics().inflight}
          </span>
          <button onClick={() => { if (connection) s.refreshBalances(connection); }} style={btnSm}>Refresh balances</button>
          {/* Аллокация 70/30 контролы */}
          <span style={{ marginLeft: 12, color: "#97a6ba", fontSize: 12 }}>Alloc:</span>
          <input
            id="alloc-target"
            name="allocTarget"
            type="number"
            min={0.05}
            max={0.95}
            step={0.01}
            value={s.allocTarget}
            onChange={(e) => s.setAlloc(safeParseNumber(e.target.value), s.allocMin, s.allocMax)}
            style={{ width: 70, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Target token allocation (0..1)"
          />
          <input
            id="alloc-min"
            name="allocMin"
            type="number"
            min={0.05}
            max={0.98}
            step={0.01}
            value={s.allocMin}
            onChange={(e) => s.setAlloc(s.allocTarget, safeParseNumber(e.target.value), s.allocMax)}
            style={{ width: 70, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Min token allocation (rebalance buy)"
          />
          <input
            id="alloc-max"
            name="allocMax"
            type="number"
            min={0.06}
            max={0.98}
            step={0.01}
            value={s.allocMax}
            onChange={(e) => s.setAlloc(s.allocTarget, s.allocMin, safeParseNumber(e.target.value))}
            style={{ width: 70, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Max token allocation (rebalance sell)"
          />
          {/* Шаг сделок */}
          <span style={{ marginLeft: 12, color: "#97a6ba", fontSize: 12 }}>Step:</span>
          <input
            id="trade-step-min"
            name="tradeStepMinSol"
            type="number"
            min={0.00005}
            step={0.00005}
            value={s.tradeStepMinSol}
            onChange={(e) => s.setTradeStep(safeParseNumber(e.target.value), s.tradeStepMaxSol, s.tradeSlicesMax, s.tradeJitterPct)}
            style={{ width: 80, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Min SOL per sub-order"
          />
          <input
            id="trade-step-max"
            name="tradeStepMaxSol"
            type="number"
            min={0.0001}
            step={0.0001}
            value={s.tradeStepMaxSol}
            onChange={(e) => s.setTradeStep(s.tradeStepMinSol, safeParseNumber(e.target.value), s.tradeSlicesMax, s.tradeJitterPct)}
            style={{ width: 80, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Max SOL per sub-order"
          />
          <input
            id="trade-slices-max"
            name="tradeSlicesMax"
            type="number"
            min={1}
            max={5}
            step={1}
            value={s.tradeSlicesMax}
            onChange={(e) => s.setTradeStep(s.tradeStepMinSol, s.tradeStepMaxSol, safeParseNumber(e.target.value), s.tradeJitterPct)}
            style={{ width: 60, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Max slices per order"
          />
          <input
            id="trade-jitter-pct"
            name="tradeJitterPct"
            type="number"
            min={0}
            max={0.5}
            step={0.01}
            value={s.tradeJitterPct}
            onChange={(e) => s.setTradeStep(s.tradeStepMinSol, s.tradeStepMaxSol, s.tradeSlicesMax, safeParseNumber(e.target.value))}
            style={{ width: 70, background: "#0b0e1a", color: "#e2e8f0", border: "1px solid #283042", borderRadius: 6, padding: "4px 6px" }}
            title="Random jitter of step size (0..0.5)"
          />
          <input
            id="token-url"
            name="tokenUrl"
            placeholder="Вставь ссылку BonkFun / LetsBonk (или mint)"
            value={s.tokenUrl}
            onChange={(e) => s.setTokenUrl(e.target.value)}
            style={inputWide}
          />
          <button onClick={() => s.tickReal()} style={btn}>
            Refresh price
          </button>
          {/* explicit wire-up to robust price feed with parsing */}
          <button
            onClick={async () => {
              try {
                const mint = parsePumpMint(s.tokenUrl) || s.tokenMint;
                if (!mint) { s.addLog("warn", "Price: mint не распознан"); return; }
                const ac = new AbortController();
                setTimeout(() => ac.abort(), 2500);
                const res = await getTokenPriceSOL(mint, ac.signal);
                if (res.price && isFinite(res.price)) {
                  useStore.setState({ price: res.price });
                  s.addLog("ok", `Price updated (${res.source}) ${res.price}`);
                } else {
                  s.addLog("warn", `Price N/A (${res.reason || 'unknown'})`);
                }
              } catch (e: any) {
                s.addLog("err", `Refresh price error: ${e?.message || String(e)}`);
              }
            }}
            style={btnSm}
          >Quick price</button>
          <div style={{ opacity: 0.7 }}>{s.tokenMint ? `mint: ${s.tokenMint}` : "mint не распознан"}</div>
        </div>

        {/* === Create Pump.fun === */}
        <div style={{ marginTop: 12, padding: 10, border: "1px dashed #2a3350", borderRadius: 10 }}>
          <div style={{ fontWeight: 600, marginBottom: 8 }}>Create Pump.fun token + авто-покупка ботами</div>
          <div style={row}>
            <span>Name</span>
            <input id="create-name" name="name" value={cName} onChange={(e) => setCName(e.target.value)} style={{ ...input, width: 160 }} />
            <span>Symbol</span>
            <input id="create-symbol" name="symbol" value={cSymbol} onChange={(e) => setCSymbol(e.target.value)} style={{ ...input, width: 120 }} />
            <span>Image URL</span>
            <input id="create-image" name="image" value={cImage} onChange={(e) => setCImage(e.target.value)} style={{ ...input, width: 260 }} />
          </div>
          <div style={row}>
            <span>Desc</span>
            <input id="create-desc" name="description" value={cDesc} onChange={(e) => setCDesc(e.target.value)} style={{ ...input, width: 420 }} />
            <span>Decimals</span>
            <input id="create-decimals" name="decimals" type="number" value={cDec} onChange={(e) => setCDec(safeParseNumber(e.target.value, 6))} style={{ ...input, width: 80 }} />
            <span>Initial buy (SOL)</span>
            <input
              id="create-initial-buy"
              name="initialBuy"
              type="number"
              step="0.001"
              value={cInitialBuy}
              onChange={(e) => setCInitialBuy(safeParseNumber(e.target.value, 0))}
              style={{ ...input, width: 120 }}
            />
            <button onClick={createPump} style={btn}>
              Create & Auto-buy
            </button>
          </div>
        </div>

        {/* Random size / Slippage */}
        <div style={row}>
          <span>Slippage (bps)</span>
          <input
            id="slippage-bps"
            name="slippageBps"
            type="number"
            step="1"
            value={s.slippageBps}
            onChange={(e) => useStore.setState({ slippageBps: Math.max(0, safeParseNumber(e.target.value, 0)) })}
            style={{ ...input, width: 90 }}
          />
          <label style={toggle}>
            <input
              id="use-random-size"
              name="useRandomSize"
              type="checkbox"
              checked={s.useRandomSize}
              onChange={(e) => useStore.setState({ useRandomSize: e.target.checked })}
            />
            Random trade size
          </label>
          <span>min</span>
          <input
            id="trade-range-min"
            name="tradeRangeMin"
            type="number"
            step="0.001"
            value={s.tradeRange.minSol}
            onChange={(e) => useStore.setState({ tradeRange: { ...s.tradeRange, minSol: safeParseNumber(e.target.value, 0) } })}
            style={{ ...input, width: 90 }}
          />
          <span>max</span>
          <input
            id="trade-range-max"
            name="tradeRangeMax"
            type="number"
            step="0.001"
            value={s.tradeRange.maxSol}
            onChange={(e) => useStore.setState({ tradeRange: { ...s.tradeRange, maxSol: safeParseNumber(e.target.value, 0) } })}
            style={{ ...input, width: 90 }}
          />
        </div>

        {/* Smart-MM */}
        <div style={row}>
          <label style={toggle}>
            <input
              id="smart-mm-enabled"
              name="smartMMEnabled"
              type="checkbox"
              checked={s.smartMM.enabled}
              onChange={(e) => useStore.setState({ smartMM: { ...s.smartMM, enabled: e.target.checked } })}
            />
            Smart-MM
          </label>
          <span>minBps</span>
          <input
            id="smart-mm-min-bps"
            name="smartMMMinBps"
            type="number"
            value={s.smartMM.minBps}
            onChange={(e) => useStore.setState({ smartMM: { ...s.smartMM, minBps: safeParseNumber(e.target.value, 20) } })}
            style={{ ...input, width: 80 }}
          />
          <span>maxBps</span>
          <input
            id="smart-mm-max-bps"
            name="smartMMMaxBps"
            type="number"
            value={s.smartMM.maxBps}
            onChange={(e) => useStore.setState({ smartMM: { ...s.smartMM, maxBps: safeParseNumber(e.target.value, 200) } })}
            style={{ ...input, width: 80 }}
          />
          <span>α</span>
          <input
            id="smart-mm-alpha"
            name="smartMMAlpha"
            type="number"
            step="0.05"
            value={s.smartMM.alpha}
            onChange={(e) => useStore.setState({ smartMM: { ...s.smartMM, alpha: safeParseNumber(e.target.value, 0.6) } })}
            style={{ ...input, width: 80 }}
          />
          <span>TWAP</span>
          <input
            id="smart-mm-twap-sec"
            name="smartMMTwapSec"
            type="number"
            value={s.smartMM.twapSec}
            onChange={(e) => useStore.setState({ smartMM: { ...s.smartMM, twapSec: safeParseNumber(e.target.value, 120) } })}
            style={{ ...input, width: 80 }}
          />
          <span>slices</span>
          <input
            id="smart-mm-twap-slices"
            name="smartMMTwapSlices"
            type="number"
            value={s.smartMM.twapSlices}
            onChange={(e) => useStore.setState({ smartMM: { ...s.smartMM, twapSlices: safeParseNumber(e.target.value, 4) } })}
            style={{ ...input, width: 80 }}
          />
          <span style={{ opacity: 0.75 }}>now bps: {s.getSmartBps()}</span>
        </div>

        {/* Комиссионный резерв / Treasury */}
        <div style={row}>
          <label style={toggle}>
            <input id="auto-top-up" name="autoTopUp" type="checkbox" checked={s.autoTopUp} onChange={(e) => useStore.setState({ autoTopUp: e.target.checked })} />
            Auto top-up
          </label>
          <span>Min fee (SOL)</span>
          <input
            id="min-fee-sol"
            name="minFeeSol"
            type="number"
            step="0.001"
            value={s.minFeeSol}
            onChange={(e) => useStore.setState({ minFeeSol: Math.max(0, safeParseNumber(e.target.value, 0)) })}
            style={{ ...input, width: 90 }}
          />
          <span>Top-up to</span>
          <input
            id="top-up-to-sol"
            name="topUpToSol"
            type="number"
            step="0.001"
            value={s.topUpToSol}
            onChange={(e) => useStore.setState({ topUpToSol: Math.max(0, safeParseNumber(e.target.value, 0)) })}
            style={{ ...input, width: 90 }}
          />
          <TreasurySetter />
        </div>

        {/* FUND / DRAIN / WARM-UP */}
        <div style={row}>
          <span>Fund total (SOL)</span>
          <input
            id="fund-total"
            name="fundTotal"
            type="number"
            step="0.001"
            value={fundTotal}
            onChange={(e) => setFundTotal(safeParseNumber(e.target.value, 0))}
            style={{ ...input, width: 120 }}
          />
          <button onClick={fundAllEqually} style={btn}>
            Fund equally (30s gap)
          </button>

          <label style={{ ...toggle, marginLeft: 8 }}>
            <input id="warm-after-fund" name="warmAfterFund" type="checkbox" checked={warmAfterFund} onChange={(e) => setWarmAfterFund(e.target.checked)} />
            Warm-up after fund (mainnet)
          </label>
          <button onClick={mainnetWarm} style={btn}>
            Mainnet warm-up (30 tx/bot)
          </button>
        </div>

        <div style={row}>
          <span>Drain keep (SOL)</span>
          <input
            id="drain-min-keep-sol"
            name="drainMinKeepSol"
            type="number"
            step="0.001"
            value={s.drainMinKeepSol}
            onChange={(e) => useStore.setState({ drainMinKeepSol: Math.max(0, safeParseNumber(e.target.value, 0)) })}
            style={{ ...input, width: 110 }}
          />
          <label style={toggle}>
            <input id="drain-to-wallet" type="radio" name="drainTo" checked={drainTo === "wallet"} onChange={() => setDrainTo("wallet")} />
            to Wallet
          </label>
          <label style={toggle}>
            <input id="drain-to-treasury" type="radio" name="drainTo" checked={drainTo === "treasury"} onChange={() => setDrainTo("treasury")} />
            to Treasury
          </label>
          <button onClick={drainAll} style={btn}>
            Drain ALL (30s gap)
          </button>
        </div>

        {/* BUY 80% */}
        <div style={row}>
          <button
            onClick={async () => {
              if (!ensureConnection()) return;
              await s.buyAllBots80OnPump(connection!);
            }}
            style={btn}
          >
            Buy 80% (bots)
          </button>
          <span style={{ opacity: 0.75 }}>Каждый бот купит на ~80% своего текущего SOL (с учётом резерва)</span>
        </div>

          {/* SELL ALL */}
          <div style={row}>
            <label style={toggle}>
              <input
                id="sell-dest-wallet"
                type="radio"
                name="sellDest"
                checked={(useStore.getState().sellAllState.destination || 'wallet') === 'wallet'}
                onChange={() =>
                  useStore.setState({
                    sellAllState: {
                      ...useStore.getState().sellAllState,
                      destination: 'wallet',
                    },
                  })
                }
              />
              to Wallet
            </label>
            <label style={toggle}>
              <input
                id="sell-dest-treasury"
                type="radio"
                name="sellDest"
                checked={(useStore.getState().sellAllState.destination || 'wallet') === 'treasury'}
                onChange={() =>
                  useStore.setState({
                    sellAllState: {
                      ...useStore.getState().sellAllState,
                      destination: 'treasury',
                    },
                  })
                }
              />
              to Treasury
            </label>
            <button
              onClick={async () => {
                if (!ensureConnection()) return;
                if (!walletPubkey) {
                  alert('Подключите Phantom');
                  return;
                }
                await s.sellAllToWalletOnPump(connection!, walletPubkey);
              }}
              style={btn}
            >
              Sell ALL via my wallet
            </button>
            <span style={{ opacity: 0.75 }}>
              bots send tokens to my wallet and the wallet sells everything in one shot
            </span>
            {s.sellAllState.status === 'running' && (
              <button onClick={() => s.cancelSellAll()} style={btnDanger}>
                Cancel
              </button>
            )}
          </div>

        {s.sellAllState.status !== 'idle' && s.sellAllState.id && (
          <div style={{ marginTop: 8, padding: 10, border: "1px dashed #2a3350", borderRadius: 10 }}>
            <div style={{ fontWeight: 600, marginBottom: 6 }}>
              Sell ALL · {s.sellAllState.destination} · {s.sellAllState.status} · op {s.sellAllState.id}
            </div>
            <div style={{ fontSize: 12, opacity: 0.8, marginBottom: 6 }}>Token | Transfer ✓ | Swap ✓ | Retries | ms | Sig</div>
            <div style={{ display: 'grid', gridTemplateColumns: 'minmax(120px,1fr) 100px 100px 80px 100px 220px', gap: 6, alignItems: 'center' }}>
              <div style={{ fontWeight: 600 }}>Bot</div>
              <div style={{ fontWeight: 600 }}>Transfer</div>
              <div style={{ fontWeight: 600 }}>Swap</div>
              <div style={{ fontWeight: 600 }}>Retries</div>
              <div style={{ fontWeight: 600 }}>ms</div>
              <div style={{ fontWeight: 600 }}>Signature</div>
              {s.bots.map((b) => {
                const p = s.sellAllState.progressByBot[b.id] || ({} as any);
                return (
                  <React.Fragment key={b.id}>
                    <div>{b.name}</div>
                    <div style={{ color: p.transferred ? '#8aff8a' : '#97a6ba' }}>{p.transferred ? '✓' : '…'}</div>
                    <div style={{ color: p.swapped ? '#8aff8a' : '#97a6ba' }}>{p.swapped ? '✓' : '-'}</div>
                    <div>{p.retries ?? 0}</div>
                    <div>{p.ms ?? ''}</div>
                    <div style={{ fontFamily: 'monospace' }}>{p.signature ? `${String(p.signature).slice(0,8)}…` : (p.error ? 'err' : '')}</div>
                  </React.Fragment>
                );
              })}
            </div>
            {s.sellAllState.msg && <div style={{ marginTop: 6, color: s.sellAllState.status === 'error' ? '#ff6b6b' : '#97a6ba' }}>{s.sellAllState.msg}</div>}
          </div>
        )}

        {/* Глобальные действия — видны всегда */}
        <div style={row}>
          <button onClick={() => s.addBot()} style={btn}>
            Add bot
          </button>
          <ImportBot />
          <button
            onClick={() => {
              if (!ensureConnection()) return;
              s.startAll(connection!);
            }}
            style={btn}
          >
            Start ALL
          </button>
          <button onClick={() => s.stopAll()} style={btn}>
            Stop ALL
          </button>
        </div>
      </div>

      {/* График */}
      <div style={{ marginTop: 12, border: "1px solid #283042", borderRadius: 10, overflow: "hidden" }}>
        <CandleTV />
      </div>

      {/* Боты */}
      {s.bots.map((b, idx) => (
        <div key={b.id} style={{ marginTop: 12, padding: 10, border: "1px solid #283042", borderRadius: 10, background: "#0f1325" }}>
          <div style={{ display: "flex", alignItems: "center", gap: 8, flexWrap: "wrap" }}>
            <div style={{ width: 20 }}>{idx + 1}</div>
            <div>
              Addr:&nbsp;<code title={b.pubkey}>{b.pubkey.slice(0, 4)}…{b.pubkey.slice(-4)}</code>
            </div>
            <button onClick={() => navigator.clipboard.writeText(b.pubkey)} style={btnSm}>
              Copy
            </button>

            <select id={`bot-table-${b.id}-strategy`} name="strategy" value={b.strategy} onChange={(e) => s.updateBot(b.id, { strategy: e.target.value as any })} style={select}>
              <option value="trend">trend</option>
              <option value="revert">revert</option>
              <option value="scalper">scalper</option>
              <option value="momentum">momentum</option>
              <option value="range">range</option>
              <option value="maker">maker</option>
            </select>

            <span>Budget (SOL)</span>
            <input
              id={`bot-table-${b.id}-budget`}
              name="budget"
              type="number"
              step="0.001"
              value={b.budgetSol}
              onChange={(e) => s.updateBot(b.id, { budgetSol: safeParseNumber(e.target.value, 0) })}
              style={{ ...input, width: 90, opacity: s.useRandomSize ? 0.75 : 1 }}
            />

            <span>Speed (ms)</span>
            <input
              id={`bot-table-${b.id}-speed`}
              name="speed"
              type="number"
              step="100"
              value={b.speedMs}
              onChange={(e) => s.updateBot(b.id, { speedMs: Math.max(200, safeParseNumber(e.target.value, 0)) })}
              style={{ ...input, width: 90 }}
            />

            <label style={toggle}>
              <input id={`bot-table-${b.id}-ai`} name="aiEnabled" type="checkbox" checked={b.aiEnabled} onChange={(e) => s.updateBot(b.id, { aiEnabled: e.target.checked })} /> AI
            </label>
            <label style={toggle}>
              <input id={`bot-table-${b.id}-manual`} name="manualLock" type="checkbox" checked={!!b.manualLock} onChange={(e) => s.updateBot(b.id, { manualLock: e.target.checked })} /> Manual
              lock
            </label>

            {!b.running ? (
              <button onClick={() => startBot(b.id)} style={btn}>
                Start
              </button>
            ) : (
              <button onClick={() => s.stopBot(b.id)} style={btnDanger}>
                Stop
              </button>
            )}
            <button onClick={() => alert(s.exportBotKey(b.id) || "no key")} style={btnSm}>
              Export key
            </button>
            <button onClick={() => s.removeBot(b.id)} style={btnSm}>
              Remove
            </button>
          </div>

          <div style={{ marginTop: 8, fontSize: 13, opacity: 0.85 }}>
            {(() => {
              const fills = b.fills ?? 0;
              const avg = (b.avgSol ?? 0).toFixed(9);
              const realized = toFixedOrZero(b.realized, 5);
              const unrl = toFixedOrZero(b.unrealized, 5);
              const sol = (b.solBalance ?? 0).toFixed(4);
              const tok = (b.tokenBalance ?? 0).toFixed(3);
              return (
                <>
                  fills: {fills} &nbsp; | &nbsp; avg: {avg} &nbsp; | &nbsp; realized:{" "}
                  <span style={{ color: "#23d18b" }}>{realized} SOL</span> &nbsp; | &nbsp; unrlzd:{" "}
                  <span style={{ color: "#23d18b" }}>{unrl} SOL</span> &nbsp; | &nbsp; SOL {sol} | TOK {tok} &nbsp; | &nbsp; last: {b.last || "hold"}
                </>
              );
            })()}
          </div>

          {(b.solBalance ?? 0) < s.minFeeSol && (
            <div style={{ marginTop: 6, color: "#ffb86c" }}>
              Внимание: на боте мало SOL (есть {(b.solBalance ?? 0).toFixed(6)}, минимум {s.minFeeSol}).{" "}
              {s.autoTopUp && s.treasuryKeyId ? "Auto top-up включён." : "Включите auto top-up или пополните вручную."}
            </div>
          )}
        </div>
      ))}

      {/* Логи */}
      <div
        style={{
          marginTop: 12,
          padding: 10,
          border: "1px solid #283042",
          borderRadius: 10,
          background: "#0f1325",
          maxHeight: 260,
          overflow: "auto",
        }}
      >
        <div style={{ fontWeight: 700, marginBottom: 8 }}>Logs</div>
        <pre style={{ margin: 0, whiteSpace: "pre-wrap" }}>
          {s.log.map((l, i) => `[${l.ts}] ${l.level.toUpperCase()} ${l.msg}`).join("\n")}
        </pre>
      </div>
    </div>
  );
}

function TreasurySetter() {
  const s = useStore();
  const [name, setName] = useState("Treasury");
  const [secret, setSecret] = useState("");
  return (
    <>
      <input id="treasury-name" name="treasuryName" placeholder="Treasury name" value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, width: 160 }} />
      <input
        id="treasury-secret"
        name="treasurySecret"
        placeholder="Treasury secret (base58/base64)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        style={{ ...input, width: 260 }}
      />
      <button
        onClick={() => {
          s.setTreasuryFromSecret(name.trim() || "Treasury", secret.trim());
          setSecret("");
        }}
        style={btn}
      >
        Set Treasury
      </button>
      <span style={{ opacity: 0.7 }}>{s.treasuryKeyId ? "Treasury установлен" : "Treasury не задан"}</span>
    </>
  );
}

function ImportBot() {
  const s = useStore();
  const [name, setName] = useState("ImportedBot");
  const [secret, setSecret] = useState("");
  return (
    <>
      <input id="import-bot-name" name="botName" placeholder="Bot name" value={name} onChange={(e) => setName(e.target.value)} style={{ ...input, width: 140 }} />
      <input
        id="import-bot-secret"
        name="botSecret"
        placeholder="Bot secret (base58/base64)"
        value={secret}
        onChange={(e) => setSecret(e.target.value)}
        style={{ ...input, width: 260 }}
      />
      <button
        onClick={() => {
          s.importBotFromSecret(name, secret);
          setSecret("");
        }}
        style={btn}
      >
        Import key
      </button>
    </>
  );
}

/* styles */
const header: React.CSSProperties = {
  display: "flex",
  alignItems: "center",
  justifyContent: "space-between",
  gap: 12,
  flexWrap: "wrap",
};
const row: React.CSSProperties = { display: "flex", gap: 8, alignItems: "center", marginTop: 10, flexWrap: "wrap" };
const input: React.CSSProperties = {
  background: "#0b0e1a",
  border: "1px solid #283042",
  color: "#e2e8f0",
  borderRadius: 8,
  padding: "6px 10px",
};
const inputWide: React.CSSProperties = { ...input, width: 420 };
const btn: React.CSSProperties = { background: "#1b5cff", color: "#fff", borderRadius: 8, padding: "8px 12px", cursor: "pointer", border: "1px solid #1b5cff" };
const btnSm: React.CSSProperties = { ...btn, padding: "6px 10px" };
const btnDanger: React.CSSProperties = { ...btn, background: "#e25454", border: "1px solid #e25454" };
const select: React.CSSProperties = { ...input };
const toggle: React.CSSProperties = { display: "flex", gap: 6, alignItems: "center" };
