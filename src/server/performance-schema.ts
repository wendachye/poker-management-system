/** Append-only v5. Ordering keys keep bounded history reads and the extrema
 * used by transactional prepend/append writes independent of payload scans.
 * Leave released migration statements unchanged after deployment.
 */
export const historyOrderingStatements = [
  "CREATE INDEX poker_ledger_order ON poker_ledger(branch_id,order_no,id)",
  "CREATE INDEX poker_approvals_order ON poker_approvals(branch_id,order_no,id)",
  "CREATE INDEX poker_audit_order ON poker_audit(branch_id,order_no,id)",
] as const;
