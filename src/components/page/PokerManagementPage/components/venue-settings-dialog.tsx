"use client";

import { useState } from "react";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Input } from "@/components/ui/input";
import { Textarea } from "@/components/ui/textarea";
import type { VenueSettings } from "@/domain/model";
import { parseMoney } from "@/domain/money";
import { defaultSettings, editableSettingsSchema } from "@/domain/settings";
import { usePokerManagementContext } from "../PokerManagementProvider";
import {
  ActionForm,
  Field,
  FormActions,
  FormGrid,
  FormSection,
  Modal,
  MoneyInput,
  Select,
  useText,
} from "./shared";

const moneyKeys = [
  "smallBlind",
  "bigBlind",
  "minBuyIn",
  "maxBuyIn",
  "buyInStep",
  "rakeCap",
] as const;
type MoneyKey = (typeof moneyKeys)[number];
type Draft = Omit<VenueSettings, MoneyKey | "rakePercent"> &
  Record<MoneyKey | "rakePercent", string>;

const labels: Record<keyof Omit<VenueSettings, "setupCompleted">, string> = {
  venueName: "Location name",
  timezone: "Time zone",
  gameType: "Game",
  gameName: "Game name",
  smallBlind: "Small blind (RM)",
  bigBlind: "Big blind (RM)",
  minBuyIn: "Minimum buy-in (RM)",
  maxBuyIn: "Maximum buy-in (RM)",
  buyInStep: "Buy-in increment (RM)",
  tipsEnabled: "Tips",
  rakeEnabled: "Rake",
  insuranceEnabled: "Insurance",
  jackpotEnabled: "Jackpot",
  creditEnabled: "Credit accounts",
  rakePercent: "Rake percentage",
  rakeCap: "Rake cap (RM)",
  tipsPolicy: "Tips policy",
  houseRules: "House rules",
};

export function VenueSettingsDialog({
  section,
  onClose,
}: {
  section: "venue" | "rules";
  onClose: () => void;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const [values, setValues] = useState<Draft>(() => {
    const branch = s.snapshot!.branch;
    const settings = s.store.settings ?? {
      ...defaultSettings(),
      venueName: branch.name,
      timezone: branch.timezone,
    };
    return {
      ...settings,
      smallBlind: String(settings.smallBlind / 100),
      bigBlind: String(settings.bigBlind / 100),
      minBuyIn: String(settings.minBuyIn / 100),
      maxBuyIn: String(settings.maxBuyIn / 100),
      buyInStep: String(settings.buyInStep / 100),
      rakeCap: String(settings.rakeCap / 100),
      rakePercent: String(settings.rakePercent),
    };
  });
  const [reason, setReason] = useState("");

  function change<K extends keyof Draft>(key: K, value: Draft[K]) {
    setValues((current) => ({ ...current, [key]: value }));
  }
  async function save() {
    const raw: Record<string, unknown> = {
      ...values,
      rakePercent: values.rakePercent.trim()
        ? Number(values.rakePercent)
        : Number.NaN,
    };
    delete raw.setupCompleted;
    for (const key of moneyKeys) {
      const positive =
        key === "smallBlind" || key === "bigBlind" || key === "maxBuyIn";
      try {
        raw[key] = parseMoney(values[key], !positive);
      } catch {
        throw new Error(
          `${t(labels[key])}: ${t(positive ? "Enter an amount greater than zero." : "Enter a valid non-negative amount.")}`,
        );
      }
    }
    const parsed = editableSettingsSchema.safeParse(raw);
    if (!parsed.success) {
      const issue = parsed.error.issues[0];
      const key = issue.path[0] as keyof typeof labels;
      if (key === "rakePercent")
        throw new Error(t("Enter a rake percentage from 0 to 100."));
      const message = t(issue.message);
      throw new Error(labels[key] ? `${t(labels[key])}: ${message}` : message);
    }
    return s.submit({
      kind: "UPDATE_SETTINGS",
      settings: parsed.data,
      reason,
    });
  }
  function moneyField(key: MoneyKey, hint?: string) {
    return (
      <Field label={labels[key]} hint={hint}>
        <MoneyInput
          required
          value={values[key]}
          onChange={(event) => change(key, event.target.value)}
        />
      </Field>
    );
  }
  const isVenue = section === "venue";
  return (
    <Modal
      open
      onOpenChange={(open) => {
        if (!open) onClose();
      }}
      title={isVenue ? "Location settings" : "Game rules and buy-ins"}
      description={
        isVenue
          ? "Set the location name, business time zone, and house rules."
          : "Set default stakes, buy-in limits, and the services available at this location."
      }
    >
      <ActionForm onSubmit={save} onSuccess={onClose}>
        {isVenue ? (
          <>
            <FormSection
              title="Venue details"
              description="Use the name and time zone for this location."
            >
              <FormGrid>
                <Field label="Location name">
                  <Input
                    required
                    maxLength={200}
                    placeholder={t("For example, Main venue")}
                    value={values.venueName}
                    onChange={(event) =>
                      change("venueName", event.target.value)
                    }
                    autoComplete="organization"
                  />
                </Field>
                <Field
                  label="Time zone"
                  hint="Used for business dates and timestamps."
                >
                  <Input
                    required
                    maxLength={100}
                    placeholder="Asia/Kuala_Lumpur"
                    value={values.timezone}
                    onChange={(event) => change("timezone", event.target.value)}
                    spellCheck={false}
                    autoComplete="off"
                  />
                </Field>
              </FormGrid>
            </FormSection>
            <FormSection
              title="House rules"
              description="Share the rules staff should follow at this location."
            >
              <Field label="House rules" optional>
                <Textarea
                  rows={5}
                  maxLength={2000}
                  placeholder={t(
                    "Add seating, conduct, and operating rules for staff.",
                  )}
                  value={values.houseRules}
                  onChange={(event) => change("houseRules", event.target.value)}
                />
              </Field>
            </FormSection>
          </>
        ) : (
          <>
            <FormSection
              title="Game and default stakes"
              description="Tables inherit these stakes unless you set different stakes for a table."
            >
              <FormGrid>
                <Field label="Game">
                  <Select
                    required
                    value={values.gameType}
                    onValueChange={(value) =>
                      change("gameType", value as VenueSettings["gameType"])
                    }
                    options={[
                      { value: "TEXAS_HOLDEM", label: "Texas Hold’em" },
                      { value: "POT_LIMIT_OMAHA", label: "Pot-limit Omaha" },
                      { value: "OTHER", label: "Other game" },
                    ]}
                  />
                </Field>
                {values.gameType === "OTHER" && (
                  <Field label="Game name">
                    <Input
                      required
                      maxLength={100}
                      placeholder={t("Enter the game name")}
                      value={values.gameName}
                      onChange={(event) =>
                        change("gameName", event.target.value)
                      }
                    />
                  </Field>
                )}
              </FormGrid>
              <div className="flex flex-wrap gap-2">
                {[
                  { small: "5", big: "10", label: "RM 5 / RM 10" },
                  { small: "10", big: "25", label: "RM 10 / RM 25" },
                ].map((preset) => (
                  <Button
                    key={preset.label}
                    type="button"
                    variant={
                      values.smallBlind === preset.small &&
                      values.bigBlind === preset.big
                        ? "secondary"
                        : "outline"
                    }
                    size="sm"
                    aria-pressed={
                      values.smallBlind === preset.small &&
                      values.bigBlind === preset.big
                    }
                    data-mark-dirty="true"
                    onClick={() =>
                      setValues((current) => ({
                        ...current,
                        smallBlind: preset.small,
                        bigBlind: preset.big,
                      }))
                    }
                  >
                    {preset.label}
                  </Button>
                ))}
              </div>
              <FormGrid>
                {moneyField("smallBlind")}
                {moneyField("bigBlind")}
              </FormGrid>
            </FormSection>
            <FormSection
              title="Buy-in limits"
              description="Limits apply to each new buy-in request. Tables can have their own limits."
            >
              <FormGrid>
                {moneyField("minBuyIn")}
                {moneyField("maxBuyIn")}
              </FormGrid>
              {moneyField(
                "buyInStep",
                "Use 0 to allow any amount in sen. Otherwise, buy-ins must be multiples of this amount.",
              )}
            </FormSection>
            <FormSection
              title="Available services"
              description="Disabling a service blocks new requests. Existing requests, repayments, and cash-outs can still be completed."
            >
              <FormGrid>
                {(
                  [
                    "creditEnabled",
                    "tipsEnabled",
                    "rakeEnabled",
                    "insuranceEnabled",
                    "jackpotEnabled",
                  ] as const
                ).map((key) => (
                  <Field key={key} label={labels[key]}>
                    <Checkbox
                      checked={values[key]}
                      onCheckedChange={(checked) =>
                        change(key, checked === true)
                      }
                    />
                  </Field>
                ))}
              </FormGrid>
            </FormSection>
            {values.rakeEnabled && (
              <FormSection
                title="Rake guidance"
                description="These values guide staff. Rake and other financial entries are entered manually and reviewed before posting."
              >
                <FormGrid>
                  <Field label="Rake percentage">
                    <Input
                      required
                      inputMode="decimal"
                      value={values.rakePercent}
                      onChange={(event) =>
                        change("rakePercent", event.target.value)
                      }
                    />
                  </Field>
                  {moneyField("rakeCap", "Use 0 for no cap.")}
                </FormGrid>
              </FormSection>
            )}
            {values.tipsEnabled && (
              <FormSection
                title="Tips policy"
                description="Explain how staff should collect and distribute tips."
              >
                <Field label="Tips policy" optional>
                  <Textarea
                    rows={3}
                    maxLength={500}
                    placeholder={t(
                      "For example, voluntary tips recorded separately from buy-ins.",
                    )}
                    value={values.tipsPolicy}
                    onChange={(event) =>
                      change("tipsPolicy", event.target.value)
                    }
                  />
                </Field>
              </FormSection>
            )}
          </>
        )}
        <FormSection
          title="Change record"
          description="This note is saved in the audit history."
        >
          <Field label="Reason for change">
            <Textarea
              required
              minLength={3}
              maxLength={500}
              rows={2}
              placeholder={t("Briefly explain what changed and why.")}
              value={reason}
              onChange={(event) => setReason(event.target.value)}
            />
          </Field>
        </FormSection>
        <FormActions>
          {isVenue ? "Save venue details" : "Save game rules"}
        </FormActions>
      </ActionForm>
    </Modal>
  );
}
