# Memo Encoding Specification

## 1. Overview

In SlipPay, payment correlation between on-chain Stellar transactions and merchant orders relies on Stellar's 32-byte `MEMO_HASH`. Because transactions on Stellar are settled non-custodially directly to merchant accounts, the memo serves as the primary cryptographic link binding an on-chain transfer to a specific pending order record.

This document establishes the single source of truth for memo encoding, length constraints, representation across tiers, and verification rules.

---

## 2. Representation & Lifecycle

| Context | Field / Type | Encoding | Length | Example |
| :--- | :--- | :--- | :--- | :--- |
| **Entropy Source** | `Uint8Array(32)` | Raw binary (CSPRNG) | 32 bytes (256 bits) | Cryptographic entropy |
| **Database Storage** | `orders.memo` (`text`) | Hex (lowercase) | 64 characters | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| **REST API** | `order.memo` (`string`) | Hex (lowercase) | 64 characters | `e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855` |
| **Stellar Horizon / RPC** | `ev.memo_b64` (`string`) | Base64 (RFC 4648 §4) | 44 characters (with `=`) | `47DEQpj8HBSa+/TImW+5JCeuQeRkm5NMpJWZG3hSuFU=` |
| **Stellar Transaction** | `xdr.Memo.memoHash` | 32-byte Hash | 32 bytes | On-chain ledger entry |

---

## 3. Generator Contract (`lib/memo.ts`)

During checkout order creation (`supabase/functions/api/lib/memo.ts`):
1. **Entropy generation**: Exactly 32 bytes of cryptographically secure random values are generated via `crypto.getRandomValues(new Uint8Array(32))`.
2. **Hex serialization**: The 32 bytes are encoded directly into a 64-character lowercase hexadecimal string using `bufToHex()`.
3. **Collision resistance**: Uniqueness across all orders is strictly guaranteed at the database schema level via a `UNIQUE` constraint on `orders.memo`.

```typescript
// supabase/functions/api/lib/memo.ts
export async function generateMemo(): Promise<string> {
  const buf = new Uint8Array(32);
  crypto.getRandomValues(buf);
  return bufToHex(buf);
}
```

---

## 4. Verification & Matching Contract (`matcher.ts`)

During payment reconciliation in the listener daemon (`apps/listener/src/matcher.ts`):

1. **Memo Type Gate**:
   - `ev.memo_type` must be `"hash"`. Non-hash memos are ignored with reason `"memo_type"`.

2. **Strict Base64 & Length Validation (`memo_malformed`)**:
   - `ev.memo_b64` must be validated against strict Base64 encoding rules (`/^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/`).
   - The decoded buffer must measure exactly 32 bytes (`buf.length === 32`).
   - The order memo must be a valid 64-character hex string (`/^[0-9a-fA-F]{64}$/`).
   - Any failure in decoding or length assertion returns `{ outcome: "ignore", reason: "memo_malformed" }`. Lenient decoding that treats corrupt input as simply non-matching is prohibited.

3. **Constant-Time Hex Comparison (`memo_mismatch`)**:
   - The 32-byte buffer is converted to a lowercase hex string: `evMemoHex = buf.toString("hex")`.
   - Comparison with `order.memo` is executed using a timing-safe string comparison function (`constantTimeEqual(evMemoHex, order.memo)`).
   - If the hashes do not match, returns `{ outcome: "ignore", reason: "memo_mismatch" }`.

```typescript
// apps/listener/src/matcher.ts
const buf = Buffer.from(ev.memo_b64, "base64");
if (
  !BASE64_STRICT_REGEX.test(ev.memo_b64) ||
  buf.length !== 32 ||
  !HEX_64_REGEX.test(order.memo)
) {
  return { outcome: "ignore", reason: "memo_malformed" };
}

const evMemoHex = buf.toString("hex").toLowerCase();
if (!constantTimeEqual(evMemoHex, order.memo.toLowerCase())) {
  return { outcome: "ignore", reason: "memo_mismatch" };
}
```

---

## 5. Security & Operational Rationale

- **Differentiating Malformed vs Mismatched**: Conflating corrupt payload events with legitimate mismatch events blinds monitoring systems to encoding bugs, serialization errors, or hostile fuzzing.
- **Timing Attack Mitigation**: Using standard string equality (`!==`) leaks mismatch positions and prefix lengths. Constant-time comparison ensures identical operational execution time regardless of character alignment.
- **Single Source of Truth**: Centralizing this specification prevents drift between generator (`memo.ts`), client signing packages, and validator (`matcher.ts`).
