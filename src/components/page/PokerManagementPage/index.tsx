"use client";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Skeleton } from "@/components/ui/skeleton";
import { usePokerManagementContext } from "./PokerManagementProvider";
import { useText } from "./components/shared";
import { OperationDialogs } from "./components/operation-dialogs";
import { DashboardView } from "./views/dashboard-view";
import { PlayersView } from "./views/players-view";
import { TablesView } from "./views/tables-view";
import { TransactionsView } from "./views/transactions-view";
import { ReportsView } from "./views/reports-view";
import { AdminView } from "./views/admin-view";
import { SettingsView } from "./views/settings-view";
import { venueSettings } from "@/domain/settings";
import { displayName } from "@/lib/display-name";
import { Link } from "@/i18n/navigation";
import { PageHeader } from "./components/page-header";
import type { ModuleKey } from "./types";
import {
  adminModules,
  settingsModules,
  isAdminSection,
  isSettingsSection,
  type SettingsSection,
  type AdminSection,
} from "@/config/management-modules";
const views = {
  dashboard: DashboardView,
  players: PlayersView,
  tables: TablesView,
  transactions: TransactionsView,
  reports: ReportsView,
  admin: AdminView,
  settings: SettingsView,
};
const descriptions: Record<ModuleKey, string> = {
  dashboard: "Monitor cash, table activity, and important alerts.",
  players: "Find a player, manage their profile, or start a new visit.",
  tables: "Manage tables, stakes, and seating.",
  transactions: "Record transactions and review requests.",
  reports:
    "Review daily cash movements and reconcile the current business day.",
  admin: "Manage staff access and review the audit history.",
  settings: "Configure locations, game rules, staff, and tables.",
};
export function PokerManagementPage({
  module,
  section,
}: {
  module: ModuleKey;
  section?: SettingsSection | AdminSection;
}) {
  const state = usePokerManagementContext();
  const t = useText();
  const View = views[module];
  const settingsSection =
    section && isSettingsSection(section) ? section : "setup";
  const adminSection = section && isAdminSection(section) ? section : "audit";
  const moduleDetails =
    module === "settings"
      ? settingsModules[settingsSection]
      : module === "admin"
        ? adminModules[adminSection]
        : null;
  const needsSetup =
    state.snapshot && !venueSettings(state.store).setupCompleted;
  return (
    <div className="min-w-0 space-y-6 sm:space-y-7">
      <PageHeader
        title={
          moduleDetails?.title ?? module[0].toUpperCase() + module.slice(1)
        }
        description={moduleDetails?.description ?? descriptions[module]}
        metadata={
          state.snapshot && (
            <dl className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-1.5 text-xs leading-5 text-muted-foreground">
              <div className="min-w-0">
                <dt className="sr-only">{t("Venue name")}</dt>
                <dd className="break-words">
                  {displayName(state.snapshot.branch.name)}
                </dd>
              </div>
              <div>
                <dt className="sr-only">{t("Date")}</dt>
                <dd className="tabular-nums">
                  {state.day?.date ?? t("No business day")}
                </dd>
              </div>
              {state.day && (
                <div>
                  <dt className="sr-only">{t("Status")}</dt>
                  <dd className="flex items-center gap-1.5">
                    <span
                      aria-hidden="true"
                      className={
                        "size-1.5 shrink-0 rounded-full " +
                        (state.locked
                          ? "bg-muted-foreground"
                          : "bg-emerald-500")
                      }
                    />
                    {t(state.locked ? "Day closed" : "Day open")}
                  </dd>
                </div>
              )}
            </dl>
          )
        }
      />
      {state.error && (
        <Alert variant="destructive" role="alert">
          <AlertTitle>{t("Action needed")}</AlertTitle>
          <AlertDescription>
            {t(state.error)}{" "}
            <Button
              variant="outline"
              size="sm"
              onClick={() => {
                state.setError("");
                void state.refresh();
              }}
            >
              {t("Refresh")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {state.retryRequired && (
        <Alert>
          <AlertDescription>
            <p>
              {t(
                "The last request has an unconfirmed result. Retry it before continuing.",
              )}
            </p>
            <Button
              disabled={state.busy}
              onClick={() => void state.retryLast()}
            >
              {t("Retry last request")}
            </Button>
          </AlertDescription>
        </Alert>
      )}
      {!state.snapshot ? (
        <div
          role="status"
          aria-label={t("Loading branch records…")}
          className="grid gap-4 sm:grid-cols-2"
        >
          <Skeleton className="h-32" />
          <Skeleton className="h-32" />
          <Skeleton className="h-64 sm:col-span-2" />
        </div>
      ) : (
        <>
          {needsSetup && module !== "settings" && (
            <Alert>
              <AlertTitle>{t("Venue setup required")}</AlertTitle>
              <AlertDescription>
                <p>
                  {t(
                    "Review staff, tables, stakes, and operating rules before opening a new business day.",
                  )}
                </p>
                {state.user?.role === "ADMIN" && (
                  <Button asChild size="sm">
                    <Link href="/settings">{t("Set up venue")}</Link>
                  </Button>
                )}
              </AlertDescription>
            </Alert>
          )}
          {module === "settings" ? (
            <SettingsView key={settingsSection} section={settingsSection} />
          ) : module === "admin" &&
            !["MANAGER", "ADMIN"].includes(state.user?.role ?? "") ? (
            <p>{t("Manager or admin access required.")}</p>
          ) : module === "admin" ? (
            <AdminView key={adminSection} section={adminSection} />
          ) : (
            <View />
          )}
          <OperationDialogs />
        </>
      )}
    </div>
  );
}
export default PokerManagementPage;
