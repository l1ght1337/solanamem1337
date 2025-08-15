// apps/web/src/polyfills.ts
// Глобально поднимаем Buffer для браузера (Vite 5 + @solana/*)
import { Buffer } from "buffer";
if (typeof window !== "undefined" && !(window as any).Buffer) {
  (window as any).Buffer = Buffer;
}
