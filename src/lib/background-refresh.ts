/** Coalesce timer/focus reads while preserving separate explicit refreshes. */
export function createBackgroundRefresh(
  refresh: () => Promise<void>,
  blocked: () => boolean,
) {
  let pending: Promise<void> | null = null;
  return function refreshInBackground(): Promise<void> {
    if (pending) return pending;
    if (blocked()) return Promise.resolve();
    const attempt = Promise.resolve().then(() => {
      if (!blocked()) return refresh();
    });
    pending = attempt;
    const clear = () => {
      if (pending === attempt) pending = null;
    };
    void attempt.then(clear, clear);
    return attempt;
  };
}
