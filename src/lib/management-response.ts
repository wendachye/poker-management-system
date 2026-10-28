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

/** Bound both the connection and response-body read; callers retain save IDs. */
export async function requestManagementJson<T>(
  request: (signal: AbortSignal) => Promise<Response>,
  signal?: AbortSignal | null,
  timeoutMs = 45_000,
): Promise<T> {
  const deadline = new AbortController();
  const timer = setTimeout(() => deadline.abort(), timeoutMs);
  const combined = signal
    ? AbortSignal.any([signal, deadline.signal])
    : deadline.signal;
  try {
    return await readManagementResponse<T>(await request(combined));
  } catch (error) {
    if (signal?.aborted) throw signal.reason;
    if (deadline.signal.aborted)
      throw new ManagementResponseError(
        "The request timed out. Retry the last request to confirm its result.",
        408,
        null,
      );
    if (error instanceof ManagementResponseError) throw error;
    throw new ManagementResponseError(
      "Cannot connect to the service. Check your connection and try again.",
      0,
      null,
      true,
    );
  } finally {
    clearTimeout(timer);
  }
}
