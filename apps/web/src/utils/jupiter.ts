import { Connection, VersionedTransaction, Keypair } from '@solana/web3.js'
import { scheduleFetch } from './network'

export const WSOL = 'So11111111111111111111111111111111111111112'

export type JupQuote = {
  inputMint: string
  outputMint: string
  inAmount: string
  outAmount: string
  otherAmountThreshold: string
  priceImpactPct?: number
  routePlan?: any[]
}

const JUP_BASE = ((import.meta as any).env?.VITE_JUP_BASE || '/jup').replace(/\/+$/, '')
const RAW_PROXIES = ((import.meta as any).env?.VITE_PUMP_PROXIES || '').trim()
const JUP_PUBLIC = 'https://quote-api.jup.ag'

async function jupFetch<T>(pathOrUrl: string, init?: RequestInit): Promise<T> {
  // Нормализуем путь для Jupiter v6
  let path = pathOrUrl
  try {
    const u = new URL(pathOrUrl)
    if (/^https:\/\/(quote-api|price)\.jup\.ag\//.test(u.href)) {
      path = `${u.pathname}${u.search}`
    }
  } catch {
    if (!/^\//.test(pathOrUrl)) path = `/${pathOrUrl}`
  }
  if (!/^\/v\d+\//.test(path)) path = `/v6${path}`

  const proxies = RAW_PROXIES
    ? RAW_PROXIES.split(',').map((s: string) => s.trim()).filter(Boolean)
    : []

  const candidates: string[] = []
  for (const p of proxies) candidates.push(`${p.replace(/\/+$/, '')}/x/pump${JUP_BASE}${path}`)
  // Всегда добавляем публичный fallback в конце
  candidates.push(`${JUP_PUBLIC}${path}`)

  let lastErr: any
  for (const url of candidates) {
    try {
      const r = await scheduleFetch(url, { ...(init as any), timeoutMs: 15000, tries: 2 }, 'jup')
      if (!r.ok) { lastErr = new Error(`Jupiter HTTP ${r.status}`); continue }
      const ct = r.headers.get('content-type') || ''
      if (!/json/i.test(ct)) {
        const txt = await r.text().catch(() => '')
        throw new Error(`Jupiter non-JSON (${r.status}) at ${url.split('?')[0]}: ${txt.slice(0,80)}`)
      }
      return r.json() as Promise<T>
    } catch (e) {
      lastErr = e
    }
  }
  throw lastErr || new Error('Jupiter fetch failed')
}

export async function getJupiterQuote(opts: {
  inputMint: string
  outputMint: string
  amount: number // input units (lamports for SOL / raw amount for SPL)
  onlyDirectRoutes?: boolean
}): Promise<JupQuote> {
  const { inputMint, outputMint, amount, onlyDirectRoutes } = opts
  const u = `/v6/quote?inputMint=${inputMint}&outputMint=${outputMint}&amount=${amount}&slippageBps=50` + (onlyDirectRoutes ? `&onlyDirectRoutes=true` : '')
  return jupFetch<JupQuote>(u)
}

export async function swapFromQuoteWithKeypair(opts: {
  connection: Connection
  keypair: Keypair
  quote: JupQuote
  slippageBps: number
  wrapAndUnwrapSol?: boolean
}): Promise<string> {
  const { connection, keypair, quote, slippageBps, wrapAndUnwrapSol } = opts
  const body = {
    quoteResponse: quote,
    userPublicKey: keypair.publicKey.toBase58(),
    slippageBps,
    wrapAndUnwrapSol: wrapAndUnwrapSol ?? true,
    dynamicComputeUnitLimit: true,
  }
  const swapRes = await jupFetch<any>('/v6/swap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })
  const b64 = String(swapRes.swapTransaction)
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  const tx = VersionedTransaction.deserialize(raw)
  tx.sign([keypair])
  const sig = await connection.sendRawTransaction(tx.serialize(), { skipPreflight: true, maxRetries: 2 })
  return sig
}

export async function jupiterSmartSwapWithKeypair(opts: {
  keypair: Keypair
  connection: Connection
  inputMint: string
  outputMint: string
  amount: number
  baseSlippageBps: number
  maxSlippageBps: number
  alpha?: number        // множитель к impact (default 1.2)
  minExtraBps?: number  // минимальная надбавка (default 10 bps)
}) {
  const {
    keypair, connection, inputMint, outputMint, amount,
    baseSlippageBps, maxSlippageBps, alpha = 1.2, minExtraBps = 10,
  } = opts

  const quote = await getJupiterQuote({ inputMint, outputMint, amount })
  const impactPct = Number(quote.priceImpactPct ?? 0)
  const extraBps = Math.max(minExtraBps, Math.ceil(impactPct * 10000 * alpha))
  const useBps = Math.min(maxSlippageBps, baseSlippageBps + extraBps)

  const sig = await swapFromQuoteWithKeypair({
    connection, keypair, quote, slippageBps: useBps, wrapAndUnwrapSol: true,
  })
  return { signature: sig, usedSlippageBps: useBps, priceImpactPct: impactPct }
}
