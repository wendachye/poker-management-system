export type PendingOperation = Readonly<{
  version: 1;
  operationId: string;
  branchId: string;
  actorId: string;
  endpoint: "/api/state" | "/api/staff" | "/api/locations";
  createdAt: number;
}>;

export type PendingOperationStorage = Pick<
  Storage,
  "length" | "key" | "getItem" | "setItem" | "removeItem"
>;

export const PENDING_OPERATION_PREFIX = "poker.pending-operation.v1.";
const MAX_STORAGE_KEYS = 4096;
const MAX_PENDING_OPERATIONS = 64;
const MAX_CHECKPOINT_CHARACTERS = 1024;
const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const KEYS = [
  "version",
  "operationId",
  "branchId",
  "actorId",
  "endpoint",
  "createdAt",
];

export class PendingOperationStorageError extends Error {
  constructor() {
    super(
      "Cannot verify the saved request checkpoint. Keep this page open and contact your administrator before submitting another request.",
    );
    this.name = "PendingOperationStorageError";
  }
}

function fail(): never {
  throw new PendingOperationStorageError();
}

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" &&
    value.length >= 1 &&
    value.length <= 100 &&
    value.trim() === value &&
    !/[\u0000-\u001f\u007f]/.test(value)
  );
}

/** This whitelist deliberately cannot retain commands, fingerprints or passwords. */
export function pendingOperation(input: unknown): PendingOperation {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input)) fail();
    const value = input as Record<string, unknown>;
    if (
      Object.keys(value).length !== KEYS.length ||
      Object.keys(value).some((key) => !KEYS.includes(key)) ||
      value.version !== 1 ||
      typeof value.operationId !== "string" ||
      !UUID.test(value.operationId) ||
      !identifier(value.branchId) ||
      !identifier(value.actorId) ||
      !["/api/state", "/api/staff", "/api/locations"].includes(
        value.endpoint as string,
      ) ||
      !Number.isSafeInteger(value.createdAt) ||
      (value.createdAt as number) < 0
    )
      fail();
    return {
      version: 1,
      operationId: value.operationId.toLowerCase(),
      branchId: value.branchId,
      actorId: value.actorId,
      endpoint: value.endpoint as PendingOperation["endpoint"],
      createdAt: value.createdAt as number,
    };
  } catch {
    return fail();
  }
}

function checkpointKey(checkpoint: PendingOperation) {
  return PENDING_OPERATION_PREFIX + checkpoint.operationId;
}

function decode(key: string, raw: string | null): PendingOperation {
  if (raw === null || raw.length > MAX_CHECKPOINT_CHARACTERS) fail();
  const checkpoint = pendingOperation(JSON.parse(raw));
  if (key !== checkpointKey(checkpoint)) fail();
  return checkpoint;
}

function same(first: PendingOperation, second: PendingOperation) {
  return KEYS.every(
    (key) =>
      first[key as keyof PendingOperation] ===
      second[key as keyof PendingOperation],
  );
}

/** Validate every app checkpoint before filtering; never silently discard corruption. */
function scan(storage: PendingOperationStorage): PendingOperation[] {
  const length = storage.length;
  if (!Number.isSafeInteger(length) || length < 0 || length > MAX_STORAGE_KEYS)
    fail();
  const entries: PendingOperation[] = [];
  const seen = new Set<string>();
  for (let index = 0; index < length; index++) {
    const key = storage.key(index);
    if (typeof key !== "string") fail();
    if (!key.startsWith(PENDING_OPERATION_PREFIX)) continue;
    if (seen.has(key) || entries.length >= MAX_PENDING_OPERATIONS) fail();
    seen.add(key);
    entries.push(decode(key, storage.getItem(key)));
  }
  return entries;
}

export function listPendingOperations(
  storage: PendingOperationStorage,
  identity: { actorId: string; branchId: string },
): PendingOperation[] {
  try {
    if (!identifier(identity.actorId) || !identifier(identity.branchId)) fail();
    return scan(storage)
      .filter(
        (checkpoint) =>
          checkpoint.actorId === identity.actorId &&
          checkpoint.branchId === identity.branchId,
      )
      .sort(
        (first, second) =>
          first.createdAt - second.createdAt ||
          first.operationId.localeCompare(second.operationId),
      );
  } catch {
    return fail();
  }
}

/** A save must not start until its metadata has survived a storage readback. */
export function writePendingOperation(
  storage: PendingOperationStorage,
  input: PendingOperation,
): void {
  try {
    const checkpoint = pendingOperation(input);
    const entries = scan(storage);
    const existing = entries.find(
      (entry) => entry.operationId === checkpoint.operationId,
    );
    if (existing && !same(existing, checkpoint)) fail();
    if (!existing && entries.length >= MAX_PENDING_OPERATIONS) fail();
    const key = checkpointKey(checkpoint);
    if (!existing) storage.setItem(key, JSON.stringify(checkpoint));
    if (!same(decode(key, storage.getItem(key)), checkpoint)) fail();
  } catch {
    fail();
  }
}

/** Remove only the exact request confirmed by a validated server receipt. */
export function clearPendingOperation(
  storage: PendingOperationStorage,
  input: PendingOperation,
): void {
  try {
    const checkpoint = pendingOperation(input);
    const key = checkpointKey(checkpoint);
    const raw = storage.getItem(key);
    // Another tab may already have confirmed and removed this exact key.
    if (raw === null) return;
    if (!same(decode(key, raw), checkpoint)) fail();
    storage.removeItem(key);
    if (storage.getItem(key) !== null) fail();
  } catch {
    fail();
  }
}
