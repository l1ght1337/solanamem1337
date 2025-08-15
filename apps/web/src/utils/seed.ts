// src/utils/seed.ts
import * as bip39 from 'bip39'
import { derivePath } from 'ed25519-hd-key'
import { Keypair } from '@solana/web3.js'

export function generateMnemonic(strength: 128 | 256 = 256) {
  return bip39.generateMnemonic(strength)
}

// Solana derivation: m/44'/501'/{index}'/0'
export async function deriveKeypairFromMnemonic(
  mnemonic: string,
  index = 0,
  passphrase = ''
): Promise<Keypair> {
  if (!bip39.validateMnemonic(mnemonic)) throw new Error('Invalid mnemonic')
  const seed = await bip39.mnemonicToSeed(mnemonic, passphrase)
  const path = `m/44'/501'/${index}'/0'`
  const { key } = derivePath(path, seed.toString('hex'))
  // key = 32 bytes
  return Keypair.fromSeed(Uint8Array.from(key))
}

export function keypairToBase64(kp: Keypair): string {
  return btoa(String.fromCharCode(...kp.secretKey))
}
