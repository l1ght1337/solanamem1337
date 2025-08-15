import { PublicKey, Transaction, VersionedTransaction } from '@solana/web3.js'

type QuoteSide = 'BUY' | 'SELL'

const QN_QUOTE = (import.meta.env as any).VITE_QN_PF_QUOTE_URL as string
const QN_SWAP  = (import.meta.env as any).VITE_QN_PF_SWAP_URL as string
const QN_KEY   = (import.meta.env as any).VITE_QN_PF_API_KEY as string | undefined

function headers() {
  const h: Record<string, string> = { 'content-type': 'application/json' }
  if (QN_KEY) h['x-api-key'] = QN_KEY
  return h
}

/** Вычисление "справедливой" цены по котировке:
 *  - для BUY: даём X SOL -> получаем Y токенов. Цена (SOL за 1 токен) = X / Y
 *  - для SELL: отдаём Y токенов -> получаем X SOL. Цена (SOL за 1 токен) = X / Y
 */
export function priceFromUi(side: QuoteSide, amountUiIn: number, amountUiOut: number) {
  if (side === 'BUY') return amountUiIn / Math.max(1e-18, amountUiOut)
  return Math.max(1e-18, amountUiOut) / Math.max(1e-18, amountUiIn)
}

/** QUICKNODE: запрос котировки.
 * amountUi — в UI-единицах (SOL для BUY, токены для SELL)
 */
export async function pfQuote(params: {
  side: QuoteSide
  mint: string
  amountUi: number
  slippageBps?: number
}) {
  if (!QN_QUOTE) throw new Error('VITE_QN_PF_QUOTE_URL is empty')
  const url = QN_QUOTE
  const body = JSON.stringify({
    type: params.side,
    mint: params.mint,
    amount: params.amountUi,          // UI-единицы
    slippageBps: params.slippageBps ?? 50,
    commitment: 'processed',
  })
  const r = await fetch(url, { method: 'POST', headers: headers(), body })
  if (!r.ok) throw new Error(`pfQuote ${r.status}: ${await r.text()}`)
  const q = await r.json()
  // ожидаем в ответе поля inAmountUi/outAmountUi (или из q.data)
  const inUi  = Number(q.inAmountUi ?? q.data?.inAmountUi ?? 0)
  const outUi = Number(q.outAmountUi ?? q.data?.outAmountUi ?? 0)
  const price = priceFromUi(params.side, inUi, outUi)
  return { raw: q, price, inAmountUi: inUi, outAmountUi: outUi }
}

/** QUICKNODE: получить unsigned swap-транзакцию в base64 под указанного payer */
export async function pfSwapTx(params: {
  side: QuoteSide
  mint: string
  amountUi: number
  slippageBps?: number
  payer: string // base58
}) {
  if (!QN_SWAP) throw new Error('VITE_QN_PF_SWAP_URL is empty')
  const url = QN_SWAP
  const body = JSON.stringify({
    type: params.side,
    mint: params.mint,
    amount: params.amountUi,
    slippageBps: params.slippageBps ?? 50,
    payer: params.payer,
    commitment: 'processed',
  })
  const r = await fetch(url, { method: 'POST', headers: headers(), body })
  if (!r.ok) throw new Error(`pfSwapTx ${r.status}: ${await r.text()}`)
  const j = await r.json()
  const b64 = j.transaction ?? j.data?.transaction
  if (typeof b64 !== 'string') throw new Error('pfSwapTx: no transaction in response')
  return b64 as string
}

/** Десериализация base64 в Transaction или VersionedTransaction (оба случая покрываем) */
export function decodeTxn(b64: string): Transaction | VersionedTransaction {
  const raw = Uint8Array.from(atob(b64), c => c.charCodeAt(0))
  try {
    return VersionedTransaction.deserialize(raw)
  } catch {
    return Transaction.from(raw)
  }
}

/** Утилита для мини-TWAP: разбиваем UI-amount по слайсам */
export function splitUiAmount(total: number, slices: number): number[] {
  if (slices <= 1) return [total]
  const part = Math.max(0, total / slices)
  return Array.from({ length: slices }, () => part)
}
