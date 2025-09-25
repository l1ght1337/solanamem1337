RUNBOOK — Solana Meme Bundler

• Jito: set VITE_USE_JITO=1 and VITE_JITO_TIP_DEFAULT for tips.
• Parallelism: set VITE_MAX_PARALLEL_SENDS (6–12 recommended). Increase gradually.
• Priority fees: adjust VITE_PRIORITY_FEE_MIN / VITE_PRIORITY_FEE_MAX.
• Monitoring: header shows RPC host and tx p95 confirm; logs show failures.
• RPC failover: set VITE_SOLANA_RPC_PRIMARY and VITE_SOLANA_RPC_FALLBACK_1.
• Treasury: set via UI (Set Treasury). Optional Sell ALL destination.
• Warm-up: run mainnet warm-up after funding to precondition RPC.
• Safety: never log private keys; only public addresses/signatures.
