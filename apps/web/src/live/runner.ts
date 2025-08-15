import { Connection, Keypair } from '@solana/web3.js'
import { jupiterSmartSwapWithKeypair, WSOL } from '../utils/jupiter'
import { decide, BotStrategy } from '../engine/strategies'

export type LiveBot = {
  id: string
  name: string
  strategy: BotStrategy
  budgetSol: number
  speedMs: number
  running: boolean
  aiEnabled: boolean
  keyId: string
  pubkey: string
  solBalance: number
  tokenBalance: number
  posToken: number
  avgSol: number
  realized: number
  unrealized: number
  fills: number
  last?: string
  lastError?: string
}

export type RunnerCtx = {
  mint: string
  slippageBps: number
  smartSlippage?: { enabled: boolean; maxBps: number; alpha: number; minExtraBps: number }
  twap?: { enabled: boolean; minChunkSol: number; maxChunks: number; delayMs: number; jitterMs: number }

  price: () => number
  change1m: () => number
  keypair: () => Keypair
  tokenDecimals: () => number
  tradeSize?: () => number
  onLog: (level: 'ok'|'warn'|'err'|'info', msg: string) => void
  onUpdate: (b: LiveBot) => void
}

const sleep = (ms: number)=> new Promise(res=>setTimeout(res, ms))

export function runBot(connection: Connection, bot: LiveBot, ctx: RunnerCtx) {
  let timer: any

  async function execOne(side: 'buy'|'sell', sizeSol: number) {
    const last = ctx.price()
    if (!last) throw new Error('no price')

    const isBuy = side === 'buy'
    const inputMint  = isBuy ? WSOL     : ctx.mint
    const outputMint = isBuy ? ctx.mint : WSOL

    // input amount: лампорты для SOL, raw для SPL
    let amount = 0
    if (isBuy) {
      amount = Math.round(sizeSol * 1e9)
    } else {
      const dec = ctx.tokenDecimals()
      const qtyToken = sizeSol / last
      amount = Math.max(1, Math.floor(qtyToken * Math.pow(10, dec)))
    }

    const smart = ctx.smartSlippage || { enabled: false, maxBps: ctx.slippageBps, alpha: 1.0, minExtraBps: 0 }
    const base = ctx.slippageBps
    const maxBps = smart.maxBps || base

    const { signature, usedSlippageBps, priceImpactPct } = await jupiterSmartSwapWithKeypair({
      keypair: ctx.keypair(), connection,
      inputMint, outputMint, amount,
      baseSlippageBps: base,
      maxSlippageBps: smart.enabled ? maxBps : base,
      alpha: smart.alpha ?? 1.2,
      minExtraBps: smart.minExtraBps ?? 10,
    })

    // учёт позиции/PNL (в токенах)
    const qtyToken = sizeSol / last
    if (isBuy) {
      const newPos = bot.posToken + qtyToken
      bot.avgSol = newPos > 0 ? (bot.avgSol * bot.posToken + sizeSol) / newPos : last
      bot.posToken = newPos
    } else {
      const sellQty = Math.min(bot.posToken, qtyToken)
      bot.posToken = Math.max(0, bot.posToken - sellQty)
      bot.realized += (last - bot.avgSol) * sellQty
      if (bot.posToken === 0) bot.avgSol = 0
    }
    bot.unrealized = bot.posToken * (last - (bot.avgSol || last))
    bot.fills += 1
    bot.last = `${side} ${sizeSol.toFixed(4)} SOL @ slp=${usedSlippageBps}bps impact=${((priceImpactPct ?? 0) * 100).toFixed(2)}%`
    ctx.onUpdate(bot)
    ctx.onLog('ok', `${bot.name} (${bot.pubkey.slice(0,4)}…): ${side.toUpperCase()} ${signature}`)
  }

  async function tick() {
    if (!bot.running) return
    try {
      const last = ctx.price()
      if (!last) return

      if (!bot.aiEnabled) { bot.last = 'ai:off'; ctx.onUpdate(bot); return schedule() }

      const decision = decide(bot.strategy, last, ctx.change1m(), bot.budgetSol)
      if (decision.side === 'hold') { bot.last = 'hold'; ctx.onUpdate(bot); return schedule() }

      const sizeSol = Math.max(0.0001, ctx.tradeSize?.() ?? decision.sizeSol ?? bot.budgetSol)

      // TWAP: делим на чанки
      const tw = ctx.twap || { enabled:false, minChunkSol: 0, maxChunks: 1, delayMs: 0, jitterMs: 0 }
      if (tw.enabled && sizeSol >= tw.minChunkSol * 2) {
        const chunks = Math.min(tw.maxChunks, Math.max(1, Math.ceil(sizeSol / Math.max(0.0001, tw.minChunkSol))))
        const chunkSize = sizeSol / chunks
        for (let i=0;i<chunks;i++){
          await execOne(decision.side as 'buy'|'sell', chunkSize)
          if (i !== chunks-1) {
            const jitter = tw.jitterMs ? Math.floor((Math.random()*2-1) * tw.jitterMs) : 0
            await sleep(Math.max(0, tw.delayMs + jitter))
          }
        }
      } else {
        await execOne(decision.side as 'buy'|'sell', sizeSol)
      }
    } catch (e:any) {
      bot.lastError = e.message || String(e)
      ctx.onUpdate(bot)
      ctx.onLog('err', `${bot.name}: ${bot.lastError}`)
    } finally {
      schedule()
    }
  }

  function schedule(){ clearTimeout(timer); timer = setTimeout(tick, bot.speedMs) }
  schedule()
  return () => clearTimeout(timer)
}
