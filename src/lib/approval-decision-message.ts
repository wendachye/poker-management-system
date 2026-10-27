import type { Store } from "../domain/model";

/** Describe the committed result, including a vote that has not posted an entry. */
export function approvalDecisionMessage(
  store: Pick<Store, "approvals" | "transactions">,
  approvalId: string,
): string {
  const request = store.approvals.find((entry) => entry.id === approvalId);
  if (request?.status === "REJECTED") return "Request rejected.";
  if (request?.status === "PENDING")
    return "Approval recorded. Another reviewer is required.";
  if (
    request?.status === "APPROVED" &&
    store.transactions.some((entry) => entry.approvalId === approvalId)
  )
    return "Approved and posted.";
  return "Saved successfully.";
}
