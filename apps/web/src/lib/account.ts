// Persistent one-touch account. The user's passkey-bound smart wallet IS their
// account — no email, no password. Stored locally so they return to it.

export type Account = {
  walletId: string;
  credIdHex: string;
  pubKeyHex: string;
  network: "TESTNET" | "PUBLIC";
  funded: string;
  createdAt: string;
};

const KEY = "slippay.account.v1";

function getStorage(): Storage | null {
  try {
    if (typeof localStorage !== "undefined") return localStorage;
  } catch {
    /* ignore restricted environments */
  }
  return null;
}

export function loadAccount(): Account | null {
  try {
    const storage = getStorage();
    if (!storage) return null;
    return JSON.parse(storage.getItem(KEY) || "null");
  } catch {
    return null;
  }
}

export function saveAccount(a: Account): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.setItem(KEY, JSON.stringify(a));
  } catch {
    /* private mode / quota exceeded */
  }
}

export function clearAccount(): void {
  try {
    const storage = getStorage();
    if (!storage) return;
    storage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}
