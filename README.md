## RUNBOOK

See `apps/web/RUNBOOK.md` for operational guidance (Jito, priority fees, parallelism, monitoring). Configure environment via `.env` using keys from `.env.example`.

# Solana Meme Bundler (Gitpod-ready)

Готовый репозиторий для Gitpod: фронтенд (Vite + React + TS), кошелёк через Solana Wallet Adapter.
**Функционал:** создание mint, запись метаданных (Token Metadata), создание ATA, минт поставки, airdrop (devnet).ааа

## Быстрый старт (Gitpod)
1. Откройте в Gitpod (или импортируйте ZIP в свой GitHub и откройте репозиторий в Gitpod).тт
2. Workspace сам запустит `pnpm dev` (порт 5173). Если не запустился — выполните вручную:
   ```bash
   cd apps/web
   pnpm install
   pnpm dev --host
   ```
3. Подключите кошелёк (Phantom/инд.) на **Devnet**.
4. Заполните поля: `Name`, `Symbol`, `Decimals`, `Supply`, `URI` (для метаданных, например ipfs://...).
5. Нажмите **Run Bundler** — шаги выполнятся по очереди. Логи выводятся в правой панели.

## Переменные окружения
По умолчанию RPC — официальный devnet. Для пользовательского RPC:
- Создайте файл `apps/web/.env`:
  ```env
  VITE_RPC_URL=https://api.devnet.solana.com
  ```

## Важно
- Проект предназначен для devnet. В mainnet используйте свой RPC и понимайте риски.
- Метаданные можно указывать через URI (IPFS/Arweave). Файл должен быть доступен публично.
