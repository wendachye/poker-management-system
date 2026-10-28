/** Immutable v2 migration statements. Entity payloads keep the domain format;
 * generated columns give PostgreSQL one source of truth for indexes/constraints.
 */
const common = `branch_id text NOT NULL REFERENCES poker_branches(id) ON DELETE CASCADE,
 id text NOT NULL, data jsonb NOT NULL, order_no bigint NOT NULL, last_revision bigint NOT NULL CHECK(last_revision >= 0),
 PRIMARY KEY(branch_id,id), CHECK((jsonb_typeof(data)='object' AND data ? 'id' AND data->>'id'=id) IS TRUE)`;
const generated = (name: string, key: string, type = "text") =>
  `${name} ${type} GENERATED ALWAYS AS (${type === "text" ? `(data->>'${key}')` : `((data->>'${key}')::${type})`}) STORED`;
const reference = (column: string, table: string) =>
  `FOREIGN KEY(branch_id,${column}) REFERENCES ${table}(branch_id,id) DEFERRABLE INITIALLY DEFERRED`;

export const indexedStorageStatements = [
  "ALTER TABLE poker_operations ADD COLUMN result_context jsonb NOT NULL DEFAULT '{}'::jsonb CHECK(jsonb_typeof(result_context)='object')",
  `DO $$ BEGIN
    IF EXISTS(SELECT 1 FROM poker_branch_state s WHERE s.data->>'schemaVersion' IS DISTINCT FROM '1'
      OR NOT s.data ? 'currentDayId' OR s.data ? 'readModel'
      OR EXISTS(SELECT 1 FROM unnest(ARRAY['profiles','tables','sessions','days','approvals','transactions','auditLogs']) AS key
        WHERE jsonb_typeof(s.data->key) IS DISTINCT FROM 'array')) THEN
      RAISE EXCEPTION 'Indexed migration requires complete legacy venue records without read-model projections';
    END IF;
  END $$`,
  `CREATE TABLE poker_profiles (${common},
    ${generated("name", "name")} NOT NULL, ${generated("phone", "phone")} NOT NULL,
    ${generated("type", "type")} NOT NULL CHECK(type IN ('CASH','CREDIT')),
    ${generated("credit_limit", "creditLimit", "bigint")} NOT NULL CHECK(credit_limit >= 0 AND credit_limit <= 9007199254740991),
    UNIQUE(branch_id,phone))`,
  `CREATE TABLE poker_tables (${common}, ${generated("name", "name")} NOT NULL,
    ${generated("status", "status")} NOT NULL CHECK(status IN ('OPEN','CLOSED')))`,
  `CREATE TABLE poker_days (${common}, ${generated("date", "date")} NOT NULL,
    ${generated("status", "status")} NOT NULL CHECK(status IN ('OPEN','CLOSED')),
    UNIQUE(branch_id,date))`,
  `CREATE TABLE poker_visits (${common},
    ${generated("player_id", "playerId")} NOT NULL, ${generated("day_id", "dayId")} NOT NULL,
    ${generated("table_id", "tableId")} NOT NULL, ${generated("status", "status")} NOT NULL CHECK(status IN ('ACTIVE','OUT')),
    ${generated("seat", "seat", "integer")} NOT NULL CHECK(seat BETWEEN 1 AND 9),
    ${generated("session_start", "sessionStart")} NOT NULL, ${generated("session_end", "sessionEnd")},
    active_player_id text GENERATED ALWAYS AS (CASE WHEN data->>'status'='ACTIVE' THEN data->>'playerId' END) STORED,
    active_table_id text GENERATED ALWAYS AS (CASE WHEN data->>'status'='ACTIVE' THEN data->>'tableId' END) STORED,
    active_seat integer GENERATED ALWAYS AS (CASE WHEN data->>'status'='ACTIVE' THEN (data->>'seat')::integer END) STORED,
    UNIQUE(branch_id,active_player_id) DEFERRABLE INITIALLY DEFERRED,
    UNIQUE(branch_id,active_table_id,active_seat) DEFERRABLE INITIALLY DEFERRED,
    ${reference("player_id", "poker_profiles")}, ${reference("day_id", "poker_days")}, ${reference("table_id", "poker_tables")})`,
  `CREATE TABLE poker_approvals (${common},
    ${generated("player_id", "playerId")}, ${generated("day_id", "dayId")} NOT NULL,
    ${generated("session_id", "sessionId")}, ${generated("table_id", "tableId")},
    ${generated("status", "status")} NOT NULL CHECK(status IN ('PENDING','APPROVED','REJECTED')),
    ${generated("type", "type")} NOT NULL, ${generated("created_at", "createdAt")} NOT NULL,
    ${generated("requested_by_id", "requestedById")} NOT NULL REFERENCES poker_users(id),
    ${generated("approval_level", "approvalLevel")} NOT NULL CHECK(approval_level IN ('MANAGER','ADMIN','DUAL')),
    ${generated("reverses_id", "reversesId")},
    ${reference("player_id", "poker_profiles")}, ${reference("day_id", "poker_days")},
    ${reference("session_id", "poker_visits")}, ${reference("table_id", "poker_tables")})`,
  `CREATE TABLE poker_ledger (${common},
    ${generated("player_id", "playerId")}, ${generated("day_id", "dayId")} NOT NULL,
    ${generated("session_id", "sessionId")}, ${generated("table_id", "tableId")}, ${generated("type", "type")} NOT NULL,
    ${generated("amount", "amount", "bigint")} NOT NULL CHECK(amount BETWEEN -9007199254740991 AND 9007199254740991),
    ${generated("cash_received", "cashReceived", "bigint")} NOT NULL CHECK(cash_received BETWEEN -9007199254740991 AND 9007199254740991),
    ${generated("cash_payout", "cashPayout", "bigint")} NOT NULL CHECK(cash_payout BETWEEN -9007199254740991 AND 9007199254740991),
    ${generated("credit_delta", "creditDelta", "bigint")} NOT NULL CHECK(credit_delta BETWEEN -9007199254740991 AND 9007199254740991),
    ${generated("time", "time")} NOT NULL, ${generated("approval_id", "approvalId")} NOT NULL,
    ${generated("reverses_id", "reversesId")}, ${generated("staff_id", "staffId")} NOT NULL REFERENCES poker_users(id),
    UNIQUE(branch_id,approval_id), UNIQUE(branch_id,reverses_id),
    ${reference("player_id", "poker_profiles")}, ${reference("day_id", "poker_days")},
    ${reference("session_id", "poker_visits")}, ${reference("table_id", "poker_tables")},
    ${reference("approval_id", "poker_approvals")}, ${reference("reverses_id", "poker_ledger")})`,
  `ALTER TABLE poker_approvals ADD ${reference("reverses_id", "poker_ledger")}`,
  `CREATE TABLE poker_audit (${common}, ${generated("time", "time")} NOT NULL,
    ${generated("actor", "actor")} NOT NULL, ${generated("actor_id", "actorId")} NOT NULL REFERENCES poker_users(id),
    ${generated("action", "action")} NOT NULL, ${generated("entity", "entity")} NOT NULL,
    ${generated("reason", "reason")} NOT NULL)`,
  `CREATE TABLE poker_change_versions (
    branch_id text NOT NULL REFERENCES poker_branches(id) ON DELETE CASCADE,
    key text NOT NULL, revision bigint NOT NULL CHECK(revision >= 0), PRIMARY KEY(branch_id,key))`,
  ...[
    ["poker_profiles", "profiles"],
    ["poker_tables", "tables"],
    ["poker_days", "days"],
    ["poker_visits", "sessions"],
    ["poker_approvals", "approvals"],
    ["poker_ledger", "transactions"],
    ["poker_audit", "auditLogs"],
  ].map(
    ([
      table,
      key,
    ]) => `INSERT INTO ${table}(branch_id,id,data,order_no,last_revision)
    SELECT s.branch_id,item.value->>'id',item.value,item.ordinality,s.revision
    FROM poker_branch_state s CROSS JOIN LATERAL jsonb_array_elements(s.data->'${key}') WITH ORDINALITY AS item(value,ordinality)`,
  ),
  // Drain deferred reference/uniqueness events after all collections exist,
  // before PostgreSQL permits creating further indexes on those tables.
  "SET CONSTRAINTS ALL IMMEDIATE",
  "ALTER TABLE poker_branch_state ADD COLUMN current_day_id text GENERATED ALWAYS AS (data->>'currentDayId') STORED",
  "ALTER TABLE poker_branch_state ADD FOREIGN KEY(branch_id,current_day_id) REFERENCES poker_days(branch_id,id) DEFERRABLE INITIALLY DEFERRED",
  `CREATE INDEX poker_profiles_name ON poker_profiles(branch_id,lower(name),id)`,
  `CREATE INDEX poker_profiles_type ON poker_profiles(branch_id,type,order_no,id)`,
  `CREATE INDEX poker_visits_day ON poker_visits(branch_id,day_id,order_no,id)`,
  `CREATE INDEX poker_visits_player ON poker_visits(branch_id,player_id,order_no,id)`,
  `CREATE INDEX poker_visits_active ON poker_visits(branch_id,status,table_id,seat)`,
  `CREATE INDEX poker_approvals_status ON poker_approvals(branch_id,status,order_no,id)`,
  `CREATE INDEX poker_approvals_day ON poker_approvals(branch_id,day_id,status,order_no,id)`,
  `CREATE INDEX poker_approvals_player ON poker_approvals(branch_id,player_id,status)`,
  `CREATE INDEX poker_approvals_session ON poker_approvals(branch_id,session_id,status)`,
  `CREATE UNIQUE INDEX poker_approvals_pending_reversal ON poker_approvals(branch_id,reverses_id) WHERE status='PENDING' AND reverses_id IS NOT NULL`,
  `CREATE INDEX poker_ledger_day ON poker_ledger(branch_id,day_id,order_no,id)`,
  `CREATE INDEX poker_ledger_player ON poker_ledger(branch_id,player_id,order_no,id)`,
  `CREATE INDEX poker_ledger_table_day ON poker_ledger(branch_id,table_id,day_id)`,
  `CREATE INDEX poker_ledger_time ON poker_ledger(branch_id,time DESC,id DESC)`,
  `CREATE INDEX poker_audit_time ON poker_audit(branch_id,time DESC,id DESC)`,
  `CREATE INDEX poker_audit_actor_action ON poker_audit(branch_id,actor,action,order_no,id)`,
  `UPDATE poker_branch_state SET data = jsonb_build_object(
    'schemaVersion',1,'storageVersion',2,'currentDayId',COALESCE(data->'currentDayId','null'::jsonb),'concurrencyFloor',revision)
    || CASE WHEN data ? 'settings' THEN jsonb_build_object('settings',data->'settings') ELSE '{}'::jsonb END`,
  `ALTER TABLE poker_branch_state ADD CONSTRAINT poker_branch_state_indexed_metadata CHECK((
    data->>'schemaVersion'='1' AND data->>'storageVersion'='2' AND data ? 'currentDayId'
    AND NOT data ?| ARRAY['profiles','tables','sessions','days','approvals','transactions','auditLogs','readModel']) IS TRUE)`,
] as const;
