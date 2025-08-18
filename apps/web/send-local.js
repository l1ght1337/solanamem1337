// scripts/send-local.js
import fs from "fs";
import bs58 from "bs58";
import { Connection, VersionedTransaction, Keypair } from "@solana/web3.js";

// Лучше отправлять через свой воркер (/rpc), а не напрямую в QuickNode:
const RPC = process.env.RPC || "https://rpc-proxy-01.lightwork1337.workers.dev/rpc";

// Приватник кошелька-подписанта (BS58!). НЕ коммить в репо, передавать через env.
const SIGNER_SECRET = process.env.SIGNER_SECRET;
if (!SIGNER_SECRET) {
  console.error("Missing SIGNER_SECRET (bs58 private key)");
  process.exit(1);
}

// tx.bin — то, что вернул trade-local (обычно base64-строка или JSON с {transaction})
const RAW = fs.readFileSync("tx.bin", "utf8").trim();
const txBase64 = RAW.startsWith("{") ? JSON.parse(RAW).transaction : RAW;

// Десериализуем, подписываем, отправляем
const conn = new Connection(RPC, "confirmed");
const signer = Keypair.fromSecretKey(bs58.decode(SIGNER_SECRET));

const tx = VersionedTransaction.deserialize(Buffer.from(txBase64, "base64"));
tx.sign([signer]);

const sig = await conn.sendRawTransaction(tx.serialize(), { skipPreflight: false });
console.log("tx signature:", sig);

// Проверим подтверждение (не обязательно)
const conf = await conn.confirmTransaction(sig, "confirmed");
console.log("confirmation:", conf.value);
