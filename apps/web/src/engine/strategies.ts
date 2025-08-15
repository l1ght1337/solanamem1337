export type Side = 'buy'|'sell'|'hold'

export type BotStrategy = 'trend'|'revert'|'scalper'
export type Decision = { side: Side; sizeSol: number; note?: string }

export function decide(
  kind: BotStrategy,
  lastPrice: number,
  change1m: number,          // относительное изменение за минуту, напр. 0.012 = +1.2%
  budgetSol: number
): Decision {
  const minTrade = Math.max(0.0005, budgetSol * 0.05)

  if (kind === 'trend') {
    if (change1m > 0.004) return { side: 'buy', sizeSol: minTrade, note: 'trend up' }
    if (change1m < -0.006) return { side: 'sell', sizeSol: minTrade, note: 'trend down' }
    return { side: 'hold', sizeSol: 0 }
  }

  if (kind === 'revert') {
    if (change1m > 0.01) return { side: 'sell', sizeSol: minTrade, note: 'fade spike' }
    if (change1m < -0.01) return { side: 'buy', sizeSol: minTrade, note: 'buy dip' }
    return { side: 'hold', sizeSol: 0 }
  }

  // scalper — мелкие случайные клики
  if (Math.random() < 0.5) return { side: 'buy',  sizeSol: minTrade * 0.5, note: 'scalp' }
  return { side: 'sell', sizeSol: minTrade * 0.5, note: 'scalp' }
}
