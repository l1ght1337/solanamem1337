// src/components/BotRow.tsx
import React from 'react';
import { useStore, LiveBot } from '../store';

const rowStyle: React.CSSProperties = {
  display: 'grid',
  gridTemplateColumns: '1fr 110px 110px 90px 80px 110px 100px 90px 90px',
  alignItems: 'center',
  gap: 8,
  padding: '10px 12px',
  borderRadius: 8,
  border: '1px solid #2f3640',
  background: '#0f131a',
};

export default function BotRow({ bot }: { bot: LiveBot }) {
  const updateBot = useStore(s => s.updateBot);
  const startBot  = useStore(s => s.startBot);
  const stopBot   = useStore(s => s.stopBot);
  const removeBot = useStore(s => s.removeBot);
  const exportKey = useStore(s => s.exportBotKey);

  return (
    <div style={rowStyle}>
      <div style={{color:'#8aa', fontSize:12}}>
        <div>Addr: <b>{bot.pubkey}</b></div>
        <div style={{opacity:.7}}>fills: {bot.fills} | avg: {(bot.posToken||0).toFixed(4)}</div>
      </div>

      <select
        value={bot.strategy}
        onChange={e => updateBot(bot.id, { strategy: e.target.value as LiveBot['strategy'] })}
        style={{ padding: 6, borderRadius:6, background:'#111826', color:'#fff', border:'1px solid #334155' }}
      >
        <option value="trend">trend</option>
        <option value="revert">revert</option>
        <option value="scalper">scalper</option>
        <option value="momentum">momentum</option>
        <option value="range">range</option>
        <option value="maker">maker</option>
      </select>

      <input
        value={bot.budgetSol}
        onChange={e => updateBot(bot.id, { budgetSol: +e.target.value })}
        style={{ padding:6, borderRadius:6, background:'#0b1220', color:'#fff', border:'1px solid #334155' }}
        placeholder="Budget (SOL)"
      />

      <input
        value={bot.speedMs}
        onChange={e => updateBot(bot.id, { speedMs: +e.target.value })}
        style={{ padding:6, borderRadius:6, background:'#0b1220', color:'#fff', border:'1px solid #334155' }}
        placeholder="Speed (ms)"
      />

      <label style={{display:'flex', alignItems:'center', gap:6}}>
        <input
          type="checkbox"
          checked={bot.aiEnabled}
          onChange={e => updateBot(bot.id, { aiEnabled: e.target.checked })}
        /> AI
      </label>

      <label style={{display:'flex', alignItems:'center', gap:6}}>
        <input
          type="checkbox"
          checked={!!bot.manualLock}
          onChange={e => updateBot(bot.id, { manualLock: e.target.checked })}
        /> Manual lock
      </label>

      {bot.running
        ? <button onClick={() => stopBot(bot.id)} className="btn">Stop</button>
        : <button onClick={() => startBot(bot.id, null as any)} className="btn">Start</button>}

      <button onClick={() => {
        const sec = exportKey(bot.id);
        if (sec) navigator.clipboard.writeText(sec);
      }} className="btn">Export key</button>

      <button onClick={() => removeBot(bot.id)} className="btn red">Remove</button>
    </div>
  );
}
