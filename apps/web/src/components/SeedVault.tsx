// src/components/SeedVault.tsx
import React, { useState } from 'react'
import { deriveKeypairFromMnemonic, generateMnemonic, keypairToBase64 } from '../utils/seed'
import { useStore } from '../store'

type SeedRec = { id: string; name: string; mnemonic: string; createdAt: number }

const NS = 'seed-vault-v1'
const load = (): SeedRec[] => { try { return JSON.parse(localStorage.getItem(NS) || '[]') } catch { return [] } }
const save = (v: SeedRec[]) => localStorage.setItem(NS, JSON.stringify(v))

export default function SeedVault({ onClose }: { onClose: () => void }) {
  const s = useStore()
  const [items, setItems] = useState<SeedRec[]>(load())
  const [name, setName] = useState('')
  const [mnemonic, setMnemonic] = useState('')

  const add = () => {
    const nm = (name || `Seed#${items.length+1}`).trim()
    const mm = mnemonic.trim() || generateMnemonic()
    const rec: SeedRec = { id: crypto.randomUUID(), name: nm, mnemonic: mm, createdAt: Date.now() }
    const arr = [...items, rec]; setItems(arr); save(arr)
    setName(''); setMnemonic('')
  }

  const del = (id: string) => { const arr = items.filter(i=>i.id!==id); setItems(arr); save(arr) }

  const createBot = async (id: string) => {
    const idxStr = prompt('Derivation index (integer)', '0'); if (idxStr == null) return
    const idx = parseInt(idxStr || '0', 10)
    const seed = items.find(x=>x.id===id); if(!seed) return
    try {
      const kp = await deriveKeypairFromMnemonic(seed.mnemonic, idx)
      const sec = keypairToBase64(kp)
      s.importBotFromSecret(`${seed.name}#${idx}`, sec)
      alert('Bot created from seed')
    } catch (e:any) {
      alert(e?.message || String(e))
    }
  }

  return (
    <div className="modal-backdrop">
      <div className="modal">
        <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
          <h3 style={{margin:0}}>🔐 Seed vault</h3>
          <button className="button" onClick={onClose}>Close</button>
        </div>

        <div className="alert">
          ВНИМАНИЕ: сид-фразы сохраняются локально в браузере (localStorage) без шифрования.
          Используйте бёрнер-сид и делайте бэкап.
        </div>

        <div className="row" style={{gap:8, flexWrap:'wrap'}}>
          <input className="input" placeholder="Название сид-фразы" value={name} onChange={e=>setName(e.target.value)} />
          <input className="input" placeholder="Mnemonic (12/24 words)" value={mnemonic} onChange={e=>setMnemonic(e.target.value)} />
          <button className="button" onClick={add}>+ Add / Generate</button>
        </div>

        <div style={{marginTop:12}}>
          {items.length===0 && <div style={{opacity:.7}}>пусто…</div>}
          {items.map(it=>(
            <div key={it.id} className="card">
              <div className="row" style={{justifyContent:'space-between', alignItems:'center'}}>
                <div>
                  <div><b>{it.name}</b></div>
                  <div style={{opacity:.8, fontSize:12, wordBreak:'break-all'}}>{it.mnemonic}</div>
                </div>
                <div className="row" style={{gap:8}}>
                  <button className="button" onClick={()=>createBot(it.id)}>Create bot from seed…</button>
                  <button className="button" onClick={()=>{navigator.clipboard.writeText(it.mnemonic); alert('Mnemonic copied')}}>Copy</button>
                  <button className="button" onClick={()=>del(it.id)}>Delete</button>
                </div>
              </div>
            </div>
          ))}
        </div>

      </div>
    </div>
  )
}
