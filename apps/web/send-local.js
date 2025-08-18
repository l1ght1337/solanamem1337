// apps/web/send-local.js
// Подписывает транзакцию из tx.bin (возвращённую /x/pump/api/trade-local)
// и отправляет её через твой /rpc (или напрямую в QuickNode, если передан RPC).
//
// Запуск (в каталоге apps/web):
//   set RPC=https://rpc-proxy-01.lightwork1337.workers.dev/rpc
//   set SIGNER_SECRET=<BS58 приватный ключ кошелька-подписанта>
//   node send-local.js
//
// Либо добавь в package.json:  "send-local": "node send-local.js"
// и запускай:  npm run send-local

import fs from "node:fs";
import { Connection, VersionedTransaction, Keypair } from "@solana/web3.js";
import bs58 from "bs58";

const RPC = process.env.RPC || "https://rpc-proxy-01.lightwork1337.workers.dev/rpc";
const SIGNER_SECRET = process.env.SIGNER_SECRET;

function fail(msg) {
  console.error(`[send-local] ${msg}`);
  process.exit(1);
}

if (!SIGNER_SECRET) {
  fail("ENV SIGNER_SECRET не задан (ожидается bs58 приватный ключ)");
}

// --- загрузка tx.bin ---
if (!fs.existsSync("tx.bin")) {
  fail("Файл tx.bin не найден рядом с send-local.js (сначала вызови /x/pump/api/trade-local)");
}

let raw = fs.readFileSync("tx.bin", "utf8").trim();
if (!raw) fail("tx.bin пустой");

// Иногда trade-local возвращает JSON с полем { transaction: "<base64>" }
if (raw.startsWith("{")) {
  try {
    const o = JSON.parse(raw);
    if (typeof o.transaction === "string") {
      raw = o.transaction.trim();
    } else if (typeof o.tx === "string") {
      raw = o.tx.trim();
    } else {
      fail("tx.bin: JSON без поля transaction");
    }
  } catch {
    fail("tx.bin: невалидный JSON");
  }
}

// --- десериализация/подпись ---
let secretBytes;
try {
  // 1) пробуем как bs58
  secretBytes = bs58.decode(SIGNER_SECRET);
} catch {
  // 2) если не bs58 — может быть JSON-массив
  try {
    const arr = JSON.parse(SIGNER_SECRET);
    if (Array.isArray(arr)) secretBytes = Uint8Array.from(arr);
  } catch { /* no-op */ }
}
if (!secretBytes || secretBytes.length < 64) {
  fail("SIGNER_SECRET не похож на корректный приватный ключ (нужен bs58 или JSON-массив из 64 чисел)");
}

const signer = Keypair.fromSecretKey(secretBytes);

let tx;
try {
  const buf = Buffer.from(raw, "base64");
  tx = VersionedTransaction.deserialize(buf);
} catch (e) {
  fail("Не удалось десериализовать транзакцию из base64: " + e.message);
}

tx.sign([signer]);

// --- отправка ---
const conn = new Connection(RPC, "confirmed");

try {
  const sig = await conn.sendRawTransaction(tx.serialize(), {
    skipPreflight: false,
    maxRetries: 3,
  });
  console.log("tx signature:", sig);
  console.log("explorer: https://solscan.io/tx/" + sig);

  const conf = await conn.confirmTransaction(sig, "confirmed");
  console.log("confirmation:", conf.value);
} catch (e) {
  // типичные причины: просроченный blockhash → получи новый tx.bin и отправь сразу
  fail("Ошибка отправки: " + (e?.message || e));
}
