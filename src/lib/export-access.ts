import type { Role } from "../domain/model";

export type ExportAccess = {
  actorId: string;
  branchId: string;
  role: Role;
};
export const EXPORT_ACCESS_HEADER = "X-Poker-Export-Access";
const invalidAccessMessage = "Reload the report before exporting.";
const keys = ["actorId", "branchId", "role"];

function identifier(value: unknown): value is string {
  return (
    typeof value === "string" && value.trim().length > 0 && value.length <= 100
  );
}

/** Validate access metadata without normalizing identity or retaining extra data. */
export function checkedExportAccess(input: unknown): ExportAccess | null {
  try {
    if (!input || typeof input !== "object" || Array.isArray(input))
      return null;
    if (
      Reflect.ownKeys(input).length !== keys.length ||
      !keys.every((key) => Object.hasOwn(input, key))
    )
      return null;
    const { actorId, branchId, role } = input as Record<string, unknown>;
    if (
      !identifier(actorId) ||
      !identifier(branchId) ||
      !["ADMIN", "MANAGER", "CASHIER", "DEALER"].includes(role as string)
    )
      return null;
    return { actorId, branchId, role: role as Role };
  } catch {
    return null;
  }
}

/** URI encoding keeps arbitrary supported IDs safe in a header, outside URLs. */
export function encodeExportAccess(access: ExportAccess): string {
  try {
    const checked = checkedExportAccess(access);
    if (checked) {
      const encoded = encodeURIComponent(JSON.stringify(checked));
      if (encoded.length <= 2048) return encoded;
    }
  } catch {}
  throw new Error(invalidAccessMessage);
}

export function decodeExportAccess(header: string | null): ExportAccess | null {
  if (typeof header !== "string" || !header.length || header.length > 2048)
    return null;
  try {
    return checkedExportAccess(JSON.parse(decodeURIComponent(header)));
  } catch {
    return null;
  }
}

export function sameExportAccess(left: unknown, right: unknown): boolean {
  const first = checkedExportAccess(left),
    second = checkedExportAccess(right);
  return (
    first !== null &&
    second !== null &&
    first.actorId === second.actorId &&
    first.branchId === second.branchId &&
    first.role === second.role
  );
}
