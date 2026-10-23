import { z } from "zod";
import { MAX_MONEY } from "./money";
import { editableSettingsSchema } from "./settings";

const id = z.string().min(1).max(100);
const text = z.string().trim().min(1).max(200);
const note = z.string().trim().min(3).max(500);
const amount = z.number().int().min(0).max(MAX_MONEY);
const seat = z.number().int().min(1).max(9);
const tag = z.enum(["VIP", "Risk", "Banned"]);
export const seatSwapParticipantSchema = z
  .object({ playerId: id, sessionId: id, tableId: id, seat })
  .strict();
export type SeatSwapParticipant = z.infer<typeof seatSwapParticipantSchema>;
export const commandSchema = z.discriminatedUnion("kind", [
  z
    .object({
      kind: z.literal("UPDATE_SETTINGS"),
      settings: editableSettingsSchema,
      reason: note,
    })
    .strict(),
  z.object({ kind: z.literal("COMPLETE_SETUP") }).strict(),
  z
    .object({
      kind: z.literal("CHECK_IN"),
      playerId: id.optional(),
      name: text,
      phone: z.string().trim().min(7).max(30),
      type: z.enum(["CASH", "CREDIT"]),
      creditLimit: amount,
      tags: z.array(tag).max(3),
      tableId: id,
      seat,
    })
    .strict(),
  z
    .object({
      kind: z.literal("UPDATE_PROFILE"),
      playerId: id,
      name: text,
      tags: z.array(tag).max(3),
      creditLimit: amount,
      reason: note,
    })
    .strict(),
  z
    .object({ kind: z.literal("MOVE"), playerId: id, tableId: id, seat })
    .strict(),
  z
    .object({
      kind: z.literal("SWAP_SEATS"),
      first: seatSwapParticipantSchema,
      second: seatSwapParticipantSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("TABLE"),
      tableId: id.optional(),
      name: text,
      dealer: z.string().trim().max(100),
      status: z.enum(["OPEN", "CLOSED"]),
      smallBlind: amount.positive().nullable().optional(),
      bigBlind: amount.positive().nullable().optional(),
      minBuyIn: amount.nullable().optional(),
      maxBuyIn: amount.positive().nullable().optional(),
      buyInStep: amount.nullable().optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("REQUEST"),
      type: z.enum([
        "Buy-in",
        "Cash-out",
        "Rake",
        "Tips",
        "Insurance Premium",
        "Insurance Payout",
        "Jackpot Contribution",
        "Jackpot Payout",
        "Cash Received",
        "Cash Payout",
        "Credit Repayment",
      ]),
      playerId: id.optional(),
      tableId: id.optional(),
      amount,
      note: z.string().trim().max(500),
    })
    .strict(),
  z
    .object({ kind: z.literal("CORRECT"), transactionId: id, reason: note })
    .strict(),
  z
    .object({
      kind: z.literal("DECIDE"),
      approvalId: id,
      decision: z.enum(["APPROVED", "REJECTED"]),
      reason: z.string().trim().max(500).optional(),
    })
    .strict(),
  z
    .object({
      kind: z.literal("OPEN_DAY"),
      date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
      openingCash: amount,
    })
    .strict(),
  z
    .object({
      kind: z.literal("CLOSE_DAY"),
      dayId: id.optional(),
      countedCash: amount,
      reason: z.string().trim().max(500),
    })
    .strict(),
  z.object({ kind: z.literal("REOPEN_DAY"), reason: note }).strict(),
]);
export type Command = z.infer<typeof commandSchema>;
export const mutationSchema = z
  .object({
    branchId: id,
    operationId: z.uuid(),
    revision: z.number().int().nonnegative(),
    command: commandSchema,
  })
  .strict();
