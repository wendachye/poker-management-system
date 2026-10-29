export const SIGN_OUT_INTENT_KEY = "poker.pending-signout.v1";

export type SignOutIntentStorage = Pick<
  Storage,
  "getItem" | "setItem" | "removeItem"
>;
type StorageAccess = () => SignOutIntentStorage;
type UrlAccess = () => string;
type HistoryAccess = {
  url: UrlAccess;
  state: () => unknown;
  replaceState: (state: unknown, unused: string, url: string) => void;
};

/** The URL fallback contains only intent, and survives quota-only storage failures. */
export function readSignOutUrlIntent(url: UrlAccess): boolean {
  try {
    return new URL(url()).searchParams.has("signout");
  } catch {
    return true;
  }
}

/** Preserve existing browser history state and verify the native URL change. */
export function writeSignOutUrlIntent(history: HistoryAccess): boolean {
  try {
    const next = new URL(history.url());
    const locale = next.pathname.split("/")[1] === "zh" ? "zh" : "en";
    // Login has no protected-layout redirect that could discard this intent.
    next.pathname = `/${locale}/login`;
    next.searchParams.set("signout", "1");
    history.replaceState(history.state(), "", next.href);
    return new URL(history.url()).href === next.href;
  } catch {
    return false;
  }
}

/** A missing marker alone permits normal access; unreadable storage stays locked. */
export function readSignOutIntent(storage: StorageAccess): boolean {
  try {
    return storage().getItem(SIGN_OUT_INTENT_KEY) !== null;
  } catch {
    return true;
  }
}

/** Persist only the sign-out intent. Failed persistence never prevents revocation. */
export function writeSignOutIntent(storage: StorageAccess): boolean {
  try {
    const target = storage();
    target.setItem(SIGN_OUT_INTENT_KEY, "1");
    return target.getItem(SIGN_OUT_INTENT_KEY) === "1";
  } catch {
    return false;
  }
}

/** Clearing is confirmed only by readback; financial checkpoints are untouched. */
export function clearSignOutIntent(storage: StorageAccess): boolean {
  try {
    const target = storage();
    target.removeItem(SIGN_OUT_INTENT_KEY);
    return target.getItem(SIGN_OUT_INTENT_KEY) === null;
  } catch {
    return false;
  }
}
