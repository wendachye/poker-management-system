import type { Staff } from "../domain/model";

export const STAFF_ACCOUNT_MISMATCH_MESSAGE =
  "The active session is for a different account. Sign in again to use the requested account.";

export class StaffAccountMismatchError extends Error {
  constructor() {
    super(STAFF_ACCOUNT_MISMATCH_MESSAGE);
    this.name = "StaffAccountMismatchError";
  }
}

export type LoginIdentity = Readonly<{ username: string; actorId?: string }>;

/** Pin account identity only; the same account may have a newer role or venue. */
export function checkedLoginIdentity(
  expected: LoginIdentity,
  user: Pick<Staff, "id" | "username">,
): LoginIdentity {
  const username = expected.username.trim().toLowerCase();
  if (
    !username ||
    user.username.trim().toLowerCase() !== username ||
    (expected.actorId !== undefined && user.id !== expected.actorId)
  )
    throw new StaffAccountMismatchError();
  return { username, actorId: user.id };
}
