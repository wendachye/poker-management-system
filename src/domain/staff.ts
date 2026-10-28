import { z } from "zod";
import type { Role } from "./model";

const role = z.enum(["DEALER", "CASHIER", "MANAGER", "ADMIN"]);
const password = z.string().min(12).max(128);
const reason = z.string().trim().min(3).max(500);
export const staffCommandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("STAFF_CREATE"),
      username: z
        .string()
        .trim()
        .toLowerCase()
        .regex(/^[a-z0-9][a-z0-9._-]{2,63}$/),
      password,
      role,
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal("STAFF_ROLE"),
      userId: z.string().min(1),
      role,
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal("STAFF_PASSWORD"),
      userId: z.string().min(1),
      password,
      enable: z.boolean(),
      reason,
    })
    .strict(),
  z
    .object({
      kind: z.literal("STAFF_DISABLE"),
      userId: z.string().min(1),
      reason,
    })
    .strict(),
]);
export const staffMutationSchema = z
  .object({
    branchId: z.string().min(1),
    actorId: z.string().min(1).max(100).optional(),
    operationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    command: staffCommandSchema,
  })
  .strict();
export type StaffCommand = z.infer<typeof staffCommandSchema>;
export type StaffAccount = {
  id: string;
  username: string;
  role: Role;
  active: boolean;
  sharedAccount: boolean;
};
