/** An HTTP failure with a safe staff message and its retry semantics. */
export class ManagementResponseError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly requestId: string | null,
    readonly uncertain = status >= 500 || status === 408,
  ) {
    super(message);
    this.name = "ManagementResponseError";
  }
}

/** Proxy error pages and incomplete responses must never become raw JSON errors. */
export async function readManagementResponse<T>(
  response: Response,
): Promise<T> {
  const reference = response.headers.get("x-request-id");
  const requestId =
    reference &&
    /^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/i.test(
      reference,
    )
      ? reference
      : null;
  let data: unknown;
  try {
    data = await response.json();
  } catch {
    // A successful status without a readable receipt does not confirm a save.
    if (response.ok)
      throw new ManagementResponseError(
        "The server response could not be confirmed. Refresh records and retry the last request.",
        response.status,
        requestId,
        true,
      );
  }
  if (!response.ok) {
    const fallback =
      response.status === 401
        ? "Your session has expired. Sign in again."
        : response.status === 403
          ? "You do not have permission to perform this action."
          : response.status === 409
            ? "Records changed. Refresh records, review them and try again."
            : "The service is unavailable. Please try again.";
    const message =
      data &&
      typeof data === "object" &&
      "error" in data &&
      typeof data.error === "string" &&
      data.error.trim() &&
      data.error.length <= 1000
        ? data.error
        : fallback;
    throw new ManagementResponseError(message, response.status, requestId);
  }
  if (!data || typeof data !== "object" || Array.isArray(data))
    throw new ManagementResponseError(
      "The server response could not be confirmed. Refresh records and retry the last request.",
      response.status,
      requestId,
      true,
    );
  return data as T;
}

/** Bound the caller's wait even if an adapter ignores cancellation. A timed-out
 * write can still commit; callers retain its save ID for exact recovery.
 */
export async function requestManagementJson<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  signal?: AbortSignal | null,
  timeoutMs = 45_000,
): Promise<T> {
  if (
    !Number.isSafeInteger(timeoutMs) ||
    timeoutMs < 1 ||
    timeoutMs > 2_147_483_647
  )
    throw new RangeError(
      "Use a positive request timeout within the timer limit.",
    );
  const expiresAt = performance.now() + timeoutMs;
  const deadline = new AbortController();
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  const timeout = () =>
    new ManagementResponseError(
      "The request timed out. Retry the last request to confirm its result.",
      408,
      null,
    );
  const expired = () =>
    deadline.signal.aborted || performance.now() >= expiresAt;
  const checkStopped = () => {
    if (signal?.aborted) throw signal.reason;
    if (expired()) {
      deadline.abort();
      throw timeout();
    }
  };
  let rejectStop: (reason: unknown) => void = () => {};
  const stopped = new Promise<never>((_, reject) => {
    rejectStop = reject;
  });
  // A synchronous expiry before the race starts must also remain observed.
  void stopped.catch(() => {});
  const onStop = () => rejectStop(combined.reason);
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    combined.addEventListener("abort", onStop, { once: true });
    checkStopped();
    timer = setTimeout(
      () => deadline.abort(),
      Math.max(0, expiresAt - performance.now()),
    );
    const work = (async () => {
      checkStopped();
      const response = await request(combined);
      checkStopped();
      const data = await readManagementResponse<T>(response);
      checkStopped();
      return data;
    })();
    // The losing work stays observed by the race. Its late headers/body cannot
    // confirm a receipt after the caller has already stopped waiting.
    const data = await Promise.race([work, stopped]);
    checkStopped();
    return data;
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (expired()) throw timeout();
    if (error instanceof ManagementResponseError) throw error;
    throw new ManagementResponseError(
      "Cannot connect to the service. Check your connection and try again.",
      0,
      null,
      true,
    );
  } finally {
    if (timer !== undefined) clearTimeout(timer);
    combined.removeEventListener("abort", onStop);
  }
}
