// Stub for @solana-program/memo (imported by @privy-io/react-auth/solana).
//
// VERIFIED SAFE (2026-06-24): `getAddMemoInstruction` is referenced by Privy ONLY
// inside `createSiwSmemoTransaction` — the Sign-In-With-Solana (external wallet)
// auth flow. This app uses EMAIL login + an embedded Solana wallet, which never
// triggers SIWS. So this function is never called on our paths (createWallet /
// signTransaction / send). If SIWS is ever enabled, install the real package and
// remove this stub + the vite alias.
//
// Why stubbed and not installed: the real @solana-program/memo@0.11.2 needs a
// @solana/kit version exposing "./program-client-core", which is incompatible with
// the @solana/kit@5.5.1 that @solana-program/token pins (see pnpm.overrides). The
// two cannot coexist, so the real package is a dependency dead-end here.
//
// Memo encoding (single source of truth: `lib/memo.ts`): the on-chain memo bytes
// are base64-encoded in the event as `memo_b64`; the canonical form used for
// comparison is the lowercase hex representation of those bytes, produced by
// `lib/memo.ts`. See that module for the authoritative encoding definition.
//
// The listener validates that `memo_b64` decodes to the expected fixed length
// before comparing, and compares in constant time (see apps/listener/src/matcher.ts).
export function getAddMemoInstruction(): never {
  throw new Error(
    "@solana-program/memo is stubbed (SIWS not used — email + embedded wallet). " +
      "If you enabled Sign-In-With-Solana, install the real package and remove the vite alias.",
  );
}
