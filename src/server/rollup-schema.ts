export const financialColumns = [
  "buy_in",
  "cash_out",
  "rake",
  "tips",
  "insurance",
  "jackpot",
  "cash_received",
  "cash_payout",
  "credit_delta",
] as const;

/** One full rebuild is used only for migration/import/recovery, never polling. */
export function financialTotalsInsertSql(branchOnly = false) {
  const type = "COALESCE(original.type,entry.type)";
  return `INSERT INTO poker_financial_totals(branch_id,scope,entity_id,day_id,${financialColumns.join(",")})
    SELECT entry.branch_id,buckets.scope,buckets.entity_id,buckets.day_id,
      sum(CASE WHEN ${type}='Buy-in' THEN entry.amount ELSE 0 END),
      sum(CASE WHEN ${type}='Cash-out' THEN entry.amount ELSE 0 END),
      sum(CASE WHEN ${type}='Rake' THEN entry.amount ELSE 0 END),
      sum(CASE WHEN ${type}='Tips' THEN entry.amount ELSE 0 END),
      sum(CASE ${type} WHEN 'Insurance Premium' THEN entry.amount WHEN 'Insurance Payout' THEN -entry.amount ELSE 0 END),
      sum(CASE ${type} WHEN 'Jackpot Contribution' THEN entry.amount WHEN 'Jackpot Payout' THEN -entry.amount ELSE 0 END),
      sum(entry.cash_received),sum(entry.cash_payout),sum(entry.credit_delta)
    FROM poker_ledger entry
    LEFT JOIN poker_ledger original ON original.branch_id=entry.branch_id AND original.id=entry.reverses_id
    CROSS JOIN LATERAL (VALUES
      ('VENUE'::text,''::text,''::text),
      ('PLAYER',entry.player_id,''),
      ('DAY','',entry.day_id),
      ('PLAYER_DAY',entry.player_id,entry.day_id),
      ('TABLE_DAY',entry.table_id,entry.day_id)
    ) buckets(scope,entity_id,day_id)
    WHERE buckets.entity_id IS NOT NULL AND buckets.day_id IS NOT NULL${branchOnly ? " AND entry.branch_id=$1" : ""}
    GROUP BY entry.branch_id,buckets.scope,buckets.entity_id,buckets.day_id`;
}

/** Append-only v3: derived totals are rebuilt from the authoritative ledger. */
export const financialRollupStatements = [
  `CREATE TABLE poker_financial_totals (
    branch_id text NOT NULL REFERENCES poker_branches(id) ON DELETE CASCADE,
    scope text NOT NULL CHECK(scope IN ('VENUE','PLAYER','DAY','PLAYER_DAY','TABLE_DAY')),
    entity_id text NOT NULL,day_id text NOT NULL,
    ${financialColumns.map((column) => `${column} numeric NOT NULL DEFAULT 0 CHECK(${column}=trunc(${column}))`).join(",")},
    player_id text GENERATED ALWAYS AS (CASE WHEN scope IN ('PLAYER','PLAYER_DAY') THEN entity_id END) STORED,
    table_id text GENERATED ALWAYS AS (CASE WHEN scope='TABLE_DAY' THEN entity_id END) STORED,
    business_day_id text GENERATED ALWAYS AS (CASE WHEN scope IN ('DAY','PLAYER_DAY','TABLE_DAY') THEN day_id END) STORED,
    PRIMARY KEY(branch_id,scope,entity_id,day_id),
    CHECK((scope='VENUE' AND entity_id='' AND day_id='')
      OR (scope='PLAYER' AND entity_id<>'' AND day_id='')
      OR (scope='DAY' AND entity_id='' AND day_id<>'')
      OR (scope IN ('PLAYER_DAY','TABLE_DAY') AND entity_id<>'' AND day_id<>'')),
    FOREIGN KEY(branch_id,player_id) REFERENCES poker_profiles(branch_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(branch_id,table_id) REFERENCES poker_tables(branch_id,id) DEFERRABLE INITIALLY DEFERRED,
    FOREIGN KEY(branch_id,business_day_id) REFERENCES poker_days(branch_id,id) DEFERRABLE INITIALLY DEFERRED
  )`,
  "CREATE INDEX poker_financial_totals_day ON poker_financial_totals(branch_id,scope,day_id,entity_id)",
  financialTotalsInsertSql(),
] as const;
