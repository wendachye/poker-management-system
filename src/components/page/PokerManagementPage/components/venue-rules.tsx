"use client";

import { useState } from "react";
import { BookOpen } from "lucide-react";
import { Button } from "@/components/ui/button";
import { venueSettings } from "@/domain/settings";
import { displayName } from "@/lib/display-name";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { money } from "../utils";
import { Modal, useText } from "./shared";

export function VenueRulesButton() {
  const [open, setOpen] = useState(false);
  const s = usePokerManagementContext();
  const settings = venueSettings(s.store);
  const t = useText();
  const game =
    settings.gameType === "OTHER"
      ? displayName(settings.gameName)
      : t(
          settings.gameType === "POT_LIMIT_OMAHA"
            ? "Pot-limit Omaha"
            : "Texas Hold’em",
        );
  return (
    <>
      <Button
        type="button"
        variant="ghost"
        className="h-11 sm:h-10"
        onClick={() => setOpen(true)}
      >
        <BookOpen />
        {t("Venue rules")}
      </Button>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Venue rules"
        description="Operating rules for this location. Tables may have different stakes and buy-in limits."
      >
        <dl className="grid gap-4 text-sm sm:grid-cols-2">
          {[
            ["Game", game],
            [
              "Default stakes",
              `${money(settings.smallBlind)} / ${money(settings.bigBlind)}`,
            ],
            [
              "Buy-in range",
              `${money(settings.minBuyIn)} – ${money(settings.maxBuyIn)}`,
            ],
            [
              "Buy-in increment",
              settings.buyInStep
                ? money(settings.buyInStep)
                : t("Any amount within limits"),
            ],
          ].map(([label, value]) => (
            <div key={label} className="space-y-1">
              <dt className="text-muted-foreground">{t(label)}</dt>
              <dd className="font-medium">{value}</dd>
            </div>
          ))}
        </dl>
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <h3 className="font-medium">{t("House rules")}</h3>
          <p className="whitespace-pre-wrap text-muted-foreground">
            {settings.houseRules || t("No house rules have been added.")}
          </p>
        </section>
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <h3 className="font-medium">{t("Rake guidance")}</h3>
          <p>
            {settings.rakeEnabled
              ? `${settings.rakePercent}% · ${t("Cap")}: ${settings.rakeCap ? money(settings.rakeCap) : t("No cap")}`
              : t("Disabled")}
          </p>
          <p className="text-muted-foreground">
            {t(
              "Rake and tips are entered manually. No amounts are deducted automatically.",
            )}
          </p>
        </section>
        <section className="space-y-2 rounded-lg border p-4 text-sm">
          <h3 className="font-medium">{t("Tips policy")}</h3>
          <p className="whitespace-pre-wrap text-muted-foreground">
            {settings.tipsEnabled
              ? settings.tipsPolicy || t("No tips policy has been added.")
              : t("Disabled")}
          </p>
        </section>
      </Modal>
    </>
  );
}
