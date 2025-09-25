RUNBOOK — Solana Meme Bundler

• Jito: set VITE_USE_JITO=true and VITE_JITO_TIP_DEFAULT for tips; app will attempt to bundle, then fallback to normal send.
• Parallelism: set VITE_MAX_PARALLEL_SENDS (8–12 recommended). App uses p-limit to parallelize transfers in Sell ALL.
• Priority fees: tune VITE_PRIORITY_FEE_MIN / VITE_PRIORITY_FEE_MAX and VITE_COMPUTE_UNITS.
• Monitoring: header shows RPC host, tx p95 (client), confirm p95 (RPC health), and current min priority fee.
• RPC failover: set VITE_SOLANA_RPC_PRIMARY and fallback(s). App auto switches on high fail rate or high p95 confirm.
• Treasury: set via UI (Set Treasury). Optional Sell ALL destination uses treasury when selected.
• Warm-up: run mainnet warm-up after funding to precondition RPC and cache blockhashes.
• Safety: never log private keys; only public addresses/signatures.
