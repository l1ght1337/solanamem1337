Solana Meme Bundler – RUNBOOK

1. Environment
- VITE_SOLANA_RPC_PRIMARY: main RPC URL
- VITE_SOLANA_RPC_FALLBACK_1 / _2: optional fallback RPCs
- VITE_API_BASE: optional Cloudflare Worker proxy for price/CORS
- VITE_MAX_PARALLEL_SENDS: parallelism for Sell ALL (default 10)
- VITE_COMPUTE_UNITS: compute unit limit (default 1,000,000)
- VITE_PRIORITY_FEE_MIN / MAX: microLamports per CU range (default 1500..25000)

2. Healthcheck & SafeBoot
- On load, header displays: RPC <host> ok | p95Tx X ms | failRate Y% | fee ~Z
- Boot logs include: Phantom status, RPC slot/p95 estimate, optional API health
- Health button (via header or run on refresh) executes:
  - RPC getLatestBlockhash + getSlot
  - getRecentPerformanceSamples(1) to infer p95ms (approx)
  - GET `${VITE_API_BASE}/healthz` if set (2s timeout)
  - Price smoke for SOL mint `So111...`

3. Logger
- Central logger with ring buffer (500), console mirror, and subscribe API in `utils/logger.ts`
- Store bridges all log entries to the UI; Logs panel updates live
- Use: `import { logger } from './utils/logger'; logger.info('msg')`

4. RPC & Failover
- `utils/connection.ts` builds connections from ENV and tracks send fail rate & p95 confirm
- Lightweight failover: if failRate exceeds threshold or p95Confirm exceeds limit, switch to next URL
- `pickHealthy(rpcs)` probes endpoints with 1.5s timeout selecting first healthy one

5. Price Feed
- `utils/priceFeed.ts` tries Jupiter v6 and optional `${API_BASE}/price?mint=` proxy
- Returns `{ price, source, reason }`; errors logged via logger
- UI “Refresh price” wired to this feed and shows source or N/A

6. Balances
- `utils/balances.ts` provides chunked `getMultipleAccountsInfo` and `getOwnerTokenAccounts`
- Store `refreshBalances(connection)` uses chunked reads and updates totals; lightRefresh guards

7. Bots & Scheduler
- Store maintains `scheduler: Map<botId, { running, abort, stopFn }>`; Start/Stop All use it
- Start is staggered by 0–400ms; loop respects `AbortSignal`; exceptions logged with backoff
- Runner uses adaptive slippage, minute limits, and corridor checks; logs to store/logger

8. Sell ALL
- `sellAllParallel` transfers from each bot to destination (wallet/treasury) in parallel (p-limit)
- Adds ComputeBudget & priority fees; retries for AccountInUse/Blockhash/Simulation exceeded
- Logs per-bot progress; UI shows progress table; Cancel aborts pending tasks

9. CSP
- No eval/new Function; production build works under strict CSP; sourcemaps disabled

10. Troubleshooting
- Price N/A: check CORS, set VITE_API_BASE proxy; logs will show source/reason
- Bots not starting: ensure SOL ≥ minFeeSol or enable autoTopUp + set Treasury
- Empty Logs: ensure `logger` subscription active; check console for CSP/network issues

