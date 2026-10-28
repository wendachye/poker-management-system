/** Migration v4; keep released statements immutable. */
export const authenticationAdmissionStatements = [
  `CREATE TABLE poker_login_budget (
    id smallint PRIMARY KEY CHECK(id=1),
    attempts integer NOT NULL CHECK(attempts BETWEEN 0 AND 121),
    window_start timestamptz NOT NULL
  )`,
  "CREATE INDEX poker_login_attempts_expiry ON poker_login_attempts(window_start,username)",
  "UPDATE poker_login_attempts SET attempts=GREATEST(0,LEAST(attempts,11)) WHERE attempts<0 OR attempts>11",
  "ALTER TABLE poker_login_attempts ADD CONSTRAINT poker_login_attempts_count CHECK(attempts BETWEEN 0 AND 11)",
  "ALTER TABLE poker_users ADD CONSTRAINT poker_users_login_namespace CHECK(username !~ '^!unknown:')",
  "CREATE INDEX poker_sessions_user ON poker_sessions(user_id)",
] as const;
