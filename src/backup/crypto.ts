/**
 * The only door to cryptography in the app: android/.../AiCryptoModule.kt (platform javax.crypto). Keys stay native
 * behind opaque handles; JavaScript passes the password once to derive a key and never stores it.
 * There is deliberately no fallback: without the native module there is no backup (never an unencrypted one).
 */
import { NativeModules } from 'react-native';

export class CryptoError extends Error {
  constructor(public code: 'unavailable' | 'unsupported' | 'auth_failed' | 'failed' | 'invalid', message: string) { super(message); }
}

function mod() {
  const m = NativeModules.AiCrypto;
  if (!m) throw new CryptoError('unavailable', 'Encryption is not available in this build, so no backup can be made or read.');
  return m;
}
async function call<T>(work: () => Promise<T>): Promise<T> {
  try { return await work(); } catch (e: any) {
    if (e instanceof CryptoError) throw e;
    const code = ['unsupported', 'auth_failed', 'invalid'].includes(e?.code) ? e.code : 'failed';
    throw new CryptoError(code, String(e?.message ?? e));
  }
}

/** n random bytes (SecureRandom) as lowercase hex. */
export const randomHex = (n: number): Promise<string> => call(() => mod().randomHex(n));
/** PBKDF2-HMAC-SHA256 → AES-256 key handle. */
export const deriveKey = (password: string, saltHex: string, iterations: number): Promise<string> => call(() => mod().deriveKey(password, saltHex, iterations));
/** AES-256-GCM: base64(ciphertext ‖ tag) of UTF-8 plaintext, with 12-byte nonce (hex) and associated data. */
export const seal = (key: string, nonceHex: string, aad: string, plaintext: string): Promise<string> => call(() => mod().seal(key, nonceHex, aad, plaintext));
/** Decrypt and authenticate (CryptoError 'auth_failed' if anything was changed or the key is wrong). */
export const open = (key: string, nonceHex: string, aad: string, sealed: string): Promise<string> => call(() => mod().open(key, nonceHex, aad, sealed));
/** Wipe a key. */
export function forget(key: string | null): void {
  if (!key) return;
  try { NativeModules.AiCrypto?.forget(key); } catch {}
}
