ts
import { bufToHex } from "@slippay/shared";

/**
 * Generates a 64-character hex memo for Stellar payments and order correlation.
 *
 * Design note (fixes #71):
 * We generate 32 cryptographically secure random bytes (256 bits of CSPRNG entropy)
 * directly from the system entropy source and hex-encode them. ...
 */
export async function generateMemo(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bufToHex(buf);
}