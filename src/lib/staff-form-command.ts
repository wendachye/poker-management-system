import type { Role } from "@/domain/model";
import type { StaffAccount, StaffCommand } from "@/domain/staff";

export type StaffFormAction = "create" | "role" | "password" | "disable";

/** The prototype adapter discards this schema placeholder; it never authenticates. */
const prototypePasswordPlaceholder = "prototype-only-no-login";

export function staffFormCommand(
  values: {
    action: StaffFormAction;
    account?: Pick<StaffAccount, "id" | "active">;
    username: string;
    role: Role;
    password: string;
    confirmation: string;
    reason: string;
  },
  prototype = false,
): StaffCommand {
  const { action, account, username, role, reason } = values;
  const needsPassword = action === "create" || action === "password";
  if (needsPassword && !prototype && values.password !== values.confirmation)
    throw new Error("Passwords do not match.");
  const password = prototype ? prototypePasswordPlaceholder : values.password;
  if (action === "create")
    return { kind: "STAFF_CREATE", username, password, role, reason };
  if (!account) throw new Error("Select a staff account.");
  if (action === "role")
    return { kind: "STAFF_ROLE", userId: account.id, role, reason };
  if (action === "disable")
    return { kind: "STAFF_DISABLE", userId: account.id, reason };
  return {
    kind: "STAFF_PASSWORD",
    userId: account.id,
    password,
    enable: !account.active,
    reason,
  };
}
