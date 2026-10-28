import "server-only";
import { z } from "zod";
import { DomainError } from "../domain/operations";
import { requireUser } from "./auth";
import type { Database } from "./database";
import { readOperationalSnapshot } from "./queries";

// Command fingerprints are hexadecimal hashes. A reserved non-hex value cannot
// match a real command and survives the existing immutable backup contract.
export const CANCELLED_OPERATION_FINGERPRINT = "cancelled:v1";

export function assertOperationNotCancelled(fingerprint: string) {
  if (fingerprint === CANCELLED_OPERATION_FINGERPRINT)
    throw new DomainError(
      "This request was cancelled during recovery and cannot be submitted again. Review the records before starting a new request.",
      409,
    );
}

const schema = z
  .object({
    branchId: z.string().min(1).max(100),
    actorId: z.string().min(1).max(100),
    operationId: z.uuid(),
  })
  .strict();

/** Resolve a lost receipt without retaining or replaying its sensitive command.
 * The branch lock serializes this tombstone with all three staff mutation paths:
 * either the original has committed, or any delayed original must now reject.
 */
export async function recoverOperation(
  db: Database,
  token: string | undefined,
  input: unknown,
) {
  const parsed = schema.safeParse(input);
  if (!parsed.success)
    throw new DomainError("Provide a valid unconfirmed request reference.");
  const { branchId, actorId, operationId } = parsed.data;
  return db.transaction(async (connection) => {
    const user = await requireUser(connection, token);
    if (user.id !== actorId)
      throw new DomainError(
        "Sign in with the account that submitted this request before recovering it.",
        409,
      );
    if (user.branchId !== branchId)
      throw new DomainError(
        "Open the venue that submitted this request before recovering it.",
        409,
      );
    const row = (
      await connection.query<{ revision: number }>(
        "SELECT revision FROM poker_branch_state WHERE branch_id=$1 FOR UPDATE",
        [branchId],
      )
    ).rows[0];
    if (!row) throw new DomainError("Branch has not been initialized.", 503);
    const authorized = await requireUser(connection, token);
    if (
      authorized.id !== user.id ||
      authorized.branchId !== user.branchId ||
      authorized.role !== user.role
    )
      throw new DomainError(
        "Your access changed. Reload this page before continuing.",
        409,
      );
    const previous = (
      await connection.query<{
        actor_id: string;
        fingerprint: string;
        result_context: {
          playerIds?: string[];
          approvalIds?: string[];
          transactionIds?: string[];
        };
      }>(
        "SELECT actor_id,fingerprint,result_context FROM poker_operations WHERE branch_id=$1 AND operation_id=$2",
        [branchId, operationId],
      )
    ).rows[0];
    if (previous && previous.actor_id !== user.id)
      throw new DomainError(
        "This request belongs to another staff account.",
        403,
      );
    if (!previous)
      await connection.query(
        "INSERT INTO poker_operations(branch_id,operation_id,actor_id,fingerprint,revision) VALUES($1,$2,$3,$4,$5)",
        [
          branchId,
          operationId,
          user.id,
          CANCELLED_OPERATION_FINGERPRINT,
          row.revision,
        ],
      );
    const status =
      previous && previous.fingerprint !== CANCELLED_OPERATION_FINGERPRINT
        ? ("saved" as const)
        : ("cancelled" as const);
    return {
      status,
      operationId,
      branchId,
      actorId,
      snapshot: await readOperationalSnapshot(
        connection,
        token,
        status === "saved" ? previous!.result_context : {},
      ),
    };
  });
}
