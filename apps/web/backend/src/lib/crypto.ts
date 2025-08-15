// Шифрование секрета бота в DO storage
const enc = new TextEncoder();
const dec = new TextDecoder();

function b64(s: ArrayBuffer | Uint8Array) {
  const bytes = s instanceof Uint8Array ? s : new Uint8Array(s);
  let bin = ''; for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}
function ub64(s: string) {
  const bin = atob(s); const u8 = new Uint8Array(bin.length);
  for (let i=0;i<bin.length;i++) u8[i] = bin.charCodeAt(i); return u8;
}

export async function importMasterKey(rawB64: string) {
  const raw = ub64(rawB64);
  return crypto.subtle.importKey('raw', raw, 'AES-GCM', false, ['encrypt','decrypt']);
}

export async function encryptAesGcm(master: CryptoKey, plainB64: string) {
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const ct = await crypto.subtle.encrypt({ name: 'AES-GCM', iv }, master, enc.encode(plainB64));
  return `${b64(iv)}.${b64(ct)}`;
}

export async function decryptAesGcm(master: CryptoKey, blob: string) {
  const [ivB64, ctB64] = blob.split('.');
  const pt = await crypto.subtle.decrypt(
    { name: 'AES-GCM', iv: ub64(ivB64) },
    master,
    ub64(ctB64)
  );
  return dec.decode(pt);
}
