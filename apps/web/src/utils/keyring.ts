import { Keypair } from '@solana/web3.js'

const NS = 'bot-keyring-v1'

export type StoredBotKey = {
  id: string
  name: string
  pubkey: string
  secretB64: string   // base64(secretKey)
}

export function listKeys(): StoredBotKey[] {
  try { return JSON.parse(localStorage.getItem(NS) || '[]') } catch { return [] }
}

function saveKeys(list: StoredBotKey[]) {
  localStorage.setItem(NS, JSON.stringify(list))
}

export function createKey(name: string): StoredBotKey {
  const kp = Keypair.generate()
  const rec: StoredBotKey = {
    id: crypto.randomUUID(),
    name,
    pubkey: kp.publicKey.toBase58(),
    secretB64: btoa(String.fromCharCode(...kp.secretKey)),
  }
  const list = listKeys()
  list.push(rec)
  saveKeys(list)
  return rec
}

// НОВОЕ: импорт по base64 секрета
export function importKey(name: string, secretB64: string): StoredBotKey {
  const clean = (secretB64 || '').trim()
  const bytes = Uint8Array.from(atob(clean), c => c.charCodeAt(0))
  const kp = Keypair.fromSecretKey(bytes)
  const rec: StoredBotKey = {
    id: crypto.randomUUID(),
    name,
    pubkey: kp.publicKey.toBase58(),
    secretB64: clean,
  }
  const list = listKeys()
  list.push(rec)
  saveKeys(list)
  return rec
}

export function exportSecret(id: string): string | null {
  const rec = listKeys().find(x => x.id === id)
  return rec?.secretB64 || null
}

export function removeKey(id: string) {
  saveKeys(listKeys().filter(x => x.id !== id))
}

export function getKeypair(id: string): Keypair | null {
  const rec = listKeys().find(x => x.id === id)
  if (!rec) return null
  const bytes = Uint8Array.from(atob(rec.secretB64), c => c.charCodeAt(0))
  return Keypair.fromSecretKey(bytes)
}
