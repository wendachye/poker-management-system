import type { Database } from "./database";

// Schema changes are applied explicitly by db:migrate, never during a request.
export const schema = `
CREATE TABLE IF NOT EXISTS poker_branches (
 id text PRIMARY KEY, name text NOT NULL, timezone text NOT NULL DEFAULT 'Asia/Kuala_Lumpur'
);
CREATE TABLE IF NOT EXISTS poker_users (
 id text PRIMARY KEY, username text NOT NULL UNIQUE, password_hash text NOT NULL, active boolean NOT NULL DEFAULT true
);
CREATE TABLE IF NOT EXISTS poker_memberships (
 user_id text NOT NULL REFERENCES poker_users(id), branch_id text NOT NULL REFERENCES poker_branches(id),
 role text NOT NULL CHECK (role IN ('DEALER','CASHIER','MANAGER','ADMIN')), PRIMARY KEY(user_id, branch_id)
);
CREATE TABLE IF NOT EXISTS poker_sessions (
 token_hash text PRIMARY KEY, user_id text NOT NULL REFERENCES poker_users(id), branch_id text NOT NULL REFERENCES poker_branches(id), expires_at timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_login_attempts (
 username text PRIMARY KEY, attempts integer NOT NULL, window_start timestamptz NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_branch_state (
 branch_id text PRIMARY KEY REFERENCES poker_branches(id), revision integer NOT NULL DEFAULT 0, data jsonb NOT NULL
);
CREATE TABLE IF NOT EXISTS poker_operations (
 branch_id text NOT NULL REFERENCES poker_branches(id), operation_id text NOT NULL, actor_id text NOT NULL REFERENCES poker_users(id),
 fingerprint text NOT NULL, revision integer NOT NULL, created_at timestamptz NOT NULL DEFAULT now(), PRIMARY KEY(branch_id, operation_id)
);
CREATE INDEX IF NOT EXISTS poker_sessions_expiry ON poker_sessions(expires_at);
`;
export async function migrate(db: Database) {
  await db.transaction(async (connection) => {
    for (const statement of schema
      .split(";")
      .map((value) => value.trim())
      .filter(Boolean))
      await connection.query(statement);
  });
}
