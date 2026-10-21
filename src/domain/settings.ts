import { z } from "zod";
import type { Store, TableRecord, VenueSettings } from "./model";
import { MAX_MONEY } from "./money";

const money = z.number().int().min(0).max(MAX_MONEY);
const timezone = z
  .string()
  .trim()
  .min(1)
  .max(100)
  .refine((value) => {
    try {
      new Intl.DateTimeFormat("en", { timeZone: value });
      return true;
    } catch {
      return false;
    }
  }, "Select a valid time zone.");

/** Defaults keep historical ledgers usable; an administrator must finish venue setup. */
export function defaultSettings(): VenueSettings {
  return {
    setupCompleted: false,
    venueName: "Local Venue",
    timezone: "Asia/Kuala_Lumpur",
    gameType: "TEXAS_HOLDEM",
    gameName: "",
    smallBlind: 100,
    bigBlind: 200,
    minBuyIn: 0,
    maxBuyIn: MAX_MONEY,
    buyInStep: 0,
    tipsEnabled: true,
    rakeEnabled: true,
    insuranceEnabled: true,
    jackpotEnabled: true,
    creditEnabled: true,
    rakePercent: 0,
    rakeCap: 0,
    tipsPolicy: "",
    houseRules: "",
  };
}

const fields = {
  venueName: z.string().trim().min(1).max(200),
  timezone,
  gameType: z.enum(["TEXAS_HOLDEM", "POT_LIMIT_OMAHA", "OTHER"]),
  gameName: z.string().trim().max(100),
  smallBlind: money.positive(),
  bigBlind: money.positive(),
  minBuyIn: money,
  maxBuyIn: money.positive(),
  buyInStep: money,
  tipsEnabled: z.boolean(),
  rakeEnabled: z.boolean(),
  insuranceEnabled: z.boolean(),
  jackpotEnabled: z.boolean(),
  creditEnabled: z.boolean(),
  rakePercent: z.number().min(0).max(100),
  rakeCap: money,
  tipsPolicy: z.string().trim().max(500),
  houseRules: z.string().trim().max(2000),
};

function consistentSettings(
  value: z.infer<z.ZodObject<typeof fields>>,
  context: z.RefinementCtx,
) {
  if (value.bigBlind < value.smallBlind)
    context.addIssue({
      code: "custom",
      path: ["bigBlind"],
      message: "Big blind must be at least the small blind.",
    });
  if (value.maxBuyIn < value.minBuyIn)
    context.addIssue({
      code: "custom",
      path: ["maxBuyIn"],
      message: "Maximum buy-in must be at least the minimum buy-in.",
    });
  if (value.gameType === "OTHER" && !value.gameName)
    context.addIssue({
      code: "custom",
      path: ["gameName"],
      message: "Enter a name for this game.",
    });
  if (
    value.buyInStep > 0 &&
    Math.ceil(Math.max(1, value.minBuyIn) / value.buyInStep) * value.buyInStep >
      value.maxBuyIn
  )
    context.addIssue({
      code: "custom",
      path: ["buyInStep"],
      message:
        "The buy-in range must allow at least one positive amount at this increment.",
    });
}

export const editableSettingsSchema = z
  .object(fields)
  .strict()
  .superRefine(consistentSettings);
export const settingsSchema = z
  .object({ ...fields, setupCompleted: z.boolean() })
  .strict()
  .superRefine(consistentSettings);

export function venueSettings(store: Pick<Store, "settings">): VenueSettings {
  return store.settings ?? defaultSettings();
}

export type TableRules = Pick<
  VenueSettings,
  "smallBlind" | "bigBlind" | "minBuyIn" | "maxBuyIn" | "buyInStep"
>;

export function effectiveTableRules(
  store: Pick<Store, "settings">,
  table?: Partial<TableRecord>,
): TableRules {
  const defaults = venueSettings(store);
  return {
    smallBlind: table?.smallBlind ?? defaults.smallBlind,
    bigBlind: table?.bigBlind ?? defaults.bigBlind,
    minBuyIn: table?.minBuyIn ?? defaults.minBuyIn,
    maxBuyIn: table?.maxBuyIn ?? defaults.maxBuyIn,
    buyInStep: table?.buyInStep ?? defaults.buyInStep,
  };
}

export function tableRuleIssue(
  store: Pick<Store, "settings">,
  table: Partial<TableRecord>,
): string | null {
  if ((table.smallBlind === undefined) !== (table.bigBlind === undefined))
    return "Set both table blinds, or let both inherit venue settings.";
  const rules = effectiveTableRules(store, table);
  if (rules.bigBlind < rules.smallBlind)
    return "Big blind must be at least the small blind.";
  if (rules.maxBuyIn < rules.minBuyIn)
    return "Maximum buy-in must be at least the minimum buy-in.";
  if (
    rules.buyInStep > 0 &&
    Math.ceil(Math.max(1, rules.minBuyIn) / rules.buyInStep) * rules.buyInStep >
      rules.maxBuyIn
  )
    return "The buy-in range must allow at least one positive amount at this increment.";
  return null;
}
