"use client";

import {
  ArrowRight,
  Users,
  ClipboardCheck,
  ChartNoAxesCombined,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Badge } from "@/components/ui/badge";
import {
  Card,
  CardHeader,
  CardTitle,
  CardDescription,
  CardContent,
} from "@/components/ui/card";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { useText } from "@/components/page/PokerManagementPage/components/shared";
import { useRouter } from "@/i18n/navigation";

const features = [
  { icon: Users, label: "Player check-in and table seating" },
  { icon: ClipboardCheck, label: "Buy-ins, approvals and cash-outs" },
  { icon: ChartNoAxesCombined, label: "Daily reports and cash reconciliation" },
] as const;

/** Front door for presentations; no real username, password or database is used. */
export function PrototypeEntry() {
  const t = useText();
  const router = useRouter();
  return (
    <main className="flex min-h-svh flex-col bg-background p-4 sm:p-6">
      <div className="flex justify-end">
        <LanguageSwitcher />
      </div>
      <div className="mx-auto flex w-full max-w-lg flex-1 items-center py-8">
        <Card className="w-full">
          <CardHeader className="space-y-3">
            <Badge variant="secondary" className="w-fit">
              {t("Frontend prototype")}
            </Badge>
            <CardTitle role="heading" aria-level={1} className="text-2xl">
              {t("Explore venue operations")}
            </CardTitle>
            <CardDescription>
              {t(
                "Try the daily workflow with fictional players and sample records. No sign-in is needed.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent className="space-y-6">
            <ul className="space-y-4 text-sm">
              {features.map(({ icon: Icon, label }) => (
                <li key={label} className="flex items-center gap-3">
                  <Icon
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span>{t(label)}</span>
                </li>
              ))}
            </ul>
            <Button
              className="h-11 w-full"
              onClick={() => router.replace("/dashboard")}
            >
              {t("Open prototype")}
              <ArrowRight aria-hidden="true" />
            </Button>
            <p className="text-xs leading-5 text-muted-foreground">
              {t(
                "Sample changes reset when you refresh the page. Your working venue data stays separate.",
              )}
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}
