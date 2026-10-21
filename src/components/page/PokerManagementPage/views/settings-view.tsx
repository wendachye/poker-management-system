"use client";
import { displayName } from "@/lib/display-name";
import { managementRequest } from "@/lib/management-request";
import { useEffect, useState } from "react";
import {
  CheckCircle2,
  Circle,
  Building2,
  Plus,
  ArrowRight,
  Pencil,
} from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Link, useRouter } from "@/i18n/navigation";
import type { SettingsSection } from "@/config/management-modules";
import { useAuth } from "@/contexts/auth-context";
import { venueSettings } from "@/domain/settings";
import type { StaffAccount } from "@/domain/staff";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { StaffManagement } from "../components/staff-management";
import { VenueSettingsDialog } from "../components/venue-settings-dialog";
import { ListToolbar } from "../components/list-toolbar";
import {
  ActionForm,
  Badge,
  EmptyState,
  Field,
  FormActions,
  FormGrid,
  FormSection,
  Modal,
  Panel,
  Pager,
  Select,
  useText,
} from "../components/shared";
import { TablesView } from "./tables-view";
import { money } from "../utils";

export function SettingsView({
  section = "setup",
}: {
  section?: SettingsSection;
}) {
  const s = usePokerManagementContext(),
    t = useText();
  const router = useRouter();
  const openSection = (target: SettingsSection) =>
    router.push(`/settings/${target}`);
  const [editor, setEditor] = useState<"venue" | "rules" | null>(null);
  const [staff, setStaff] = useState<StaffAccount[] | null>(null);
  const [staffError, setStaffError] = useState("");
  const [staffReload, setStaffReload] = useState(0);
  const settings = venueSettings(s.store);
  const saved = !!s.store.settings;
  const admin = s.user?.role === "ADMIN";
  useEffect(() => {
    if (!admin || section !== "setup") return;
    const controller = new AbortController();
    void managementRequest("/api/staff", {
      cache: "no-store",
      signal: controller.signal,
    })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (data.branchId !== s.snapshot?.branch.id)
          throw new Error(
            "Your active branch changed. Reload this page before continuing.",
          );
        setStaff(data.accounts);
        setStaffError("");
      })
      .catch((error: unknown) => {
        if (!controller.signal.aborted)
          setStaffError(
            error instanceof Error
              ? error.message
              : "Cannot load staff accounts.",
          );
      });
    return () => controller.abort();
  }, [
    admin,
    section,
    s.snapshot?.branch.id,
    s.snapshot?.revision,
    staffReload,
  ]);
  const operators = (staff ?? []).filter(
    (a) => a.active && ["CASHIER", "MANAGER"].includes(a.role),
  );
  const hasReviewers = operators.some((operator) =>
    staff?.some(
      (reviewer) =>
        reviewer.active &&
        reviewer.id !== operator.id &&
        ["MANAGER", "ADMIN"].includes(reviewer.role),
    ),
  );
  const openTables = s.tables.filter((table) => table.status === "OPEN").length;
  const ready = saved && !!openTables && hasReviewers && !staffError;
  const checks = [
    { tab: "venue" as const, label: "Venue and game rules saved", done: saved },
    {
      tab: "staff" as const,
      label: "Cashier and independent reviewer available",
      done: hasReviewers,
    },
    {
      tab: "tables" as const,
      label: "At least one open table configured",
      done: openTables > 0,
    },
  ];
  if (!admin)
    return (
      <Alert>
        <AlertDescription>
          {t(
            "Ask an administrator to complete venue setup before opening a business day.",
          )}
        </AlertDescription>
      </Alert>
    );
  return (
    <div className="space-y-5">
      {section === "setup" && (
        <Panel
          title={
            settings.setupCompleted ? "Venue settings" : "Set up your venue"
          }
          description="Configure this location before opening its first business day. You can update these settings later."
        >
          <div className="flex flex-wrap items-center gap-3">
            <Badge tone={settings.setupCompleted ? "green" : "amber"}>
              {settings.setupCompleted ? "Setup complete" : "Setup required"}
            </Badge>
            <span className="text-sm text-muted-foreground">
              {checks.filter((c) => c.done).length} / {checks.length}{" "}
              {t("setup checks complete")}
            </span>
          </div>
          <div className="grid gap-2 lg:grid-cols-3">
            {checks.map((check) => (
              <Button
                key={check.tab}
                variant="outline"
                className="h-auto min-h-14 justify-start whitespace-normal text-left"
                onClick={() => openSection(check.tab)}
              >
                {check.done ? (
                  <CheckCircle2 className="shrink-0 text-emerald-600" />
                ) : (
                  <Circle className="shrink-0 text-muted-foreground" />
                )}
                {t(check.label)}
              </Button>
            ))}
          </div>
          {!settings.setupCompleted && (
            <p className="text-sm text-muted-foreground">
              {t(
                "Existing open days can finish normally. Complete setup before opening the next day.",
              )}
            </p>
          )}
        </Panel>
      )}
      {section === "venue" && (
        <div className="space-y-5">
          <Panel
            title="Location details"
            action={
              <Button variant="outline" onClick={() => setEditor("venue")}>
                <Pencil />
                {t("Edit location")}
              </Button>
            }
          >
            <dl className="grid gap-4 text-sm sm:grid-cols-2">
              <div>
                <dt className="text-muted-foreground">{t("Venue name")}</dt>
                <dd className="font-medium">
                  {displayName(s.snapshot!.branch.name)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("Time zone")}</dt>
                <dd className="font-medium">{s.snapshot!.branch.timezone}</dd>
              </div>
            </dl>
            {settings.houseRules && (
              <p className="whitespace-pre-wrap text-sm">
                {settings.houseRules}
              </p>
            )}
            {!saved && (
              <Alert>
                <AlertDescription>
                  {t(
                    "Review and save your venue and game defaults, then configure staff and tables.",
                  )}
                </AlertDescription>
              </Alert>
            )}
          </Panel>
          <Panel
            title="Game and money rules"
            action={
              <Button onClick={() => setEditor("rules")}>
                <Pencil />
                {t("Edit game rules")}
              </Button>
            }
          >
            <dl className="grid gap-4 text-sm sm:grid-cols-2 xl:grid-cols-3">
              <div>
                <dt className="text-muted-foreground">{t("Game")}</dt>
                <dd>
                  {t(
                    settings.gameType === "TEXAS_HOLDEM"
                      ? "Texas Hold’em"
                      : settings.gameType === "POT_LIMIT_OMAHA"
                        ? "Pot-limit Omaha"
                        : displayName(settings.gameName || "Other game"),
                  )}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("Default stakes")}</dt>
                <dd>
                  {money(settings.smallBlind)} / {money(settings.bigBlind)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("Buy-in range")}</dt>
                <dd>
                  {money(settings.minBuyIn)} – {money(settings.maxBuyIn)}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">
                  {t("Buy-in increment")}
                </dt>
                <dd>
                  {settings.buyInStep
                    ? money(settings.buyInStep)
                    : t("Any amount within limits")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("Rake guidance")}</dt>
                <dd>
                  {settings.rakeEnabled
                    ? `${settings.rakePercent}% · ${t("Cap")}: ${settings.rakeCap ? money(settings.rakeCap) : t("No cap")}`
                    : t("Disabled")}
                </dd>
              </div>
              <div>
                <dt className="text-muted-foreground">{t("Tips")}</dt>
                <dd>{t(settings.tipsEnabled ? "Enabled" : "Disabled")}</dd>
              </div>
            </dl>
            <div className="flex flex-wrap gap-2">
              {[
                [settings.creditEnabled, "Credit accounts"],
                [settings.insuranceEnabled, "Insurance"],
                [settings.jackpotEnabled, "Jackpot"],
              ].map(([enabled, label]) => (
                <Badge key={String(label)}>
                  {t(String(label)) +
                    ": " +
                    t(enabled ? "Enabled" : "Disabled")}
                </Badge>
              ))}
            </div>
            <p className="text-sm text-muted-foreground">
              {t(
                "Tables can override stakes and buy-in limits. Rake and tips are recorded as actual amounts and are never deducted automatically.",
              )}
            </p>
            {settings.tipsPolicy && (
              <p className="whitespace-pre-wrap text-sm">
                {settings.tipsPolicy}
              </p>
            )}
            <Button variant="outline" onClick={() => openSection("staff")}>
              {t("Continue to staff")}
              <ArrowRight />
            </Button>
          </Panel>
        </div>
      )}
      {section === "staff" && (
        <div className="space-y-4">
          <StaffManagement />
          <Button variant="outline" onClick={() => openSection("tables")}>
            {t("Continue to tables")}
            <ArrowRight />
          </Button>
        </div>
      )}
      {section === "tables" && (
        <div className="space-y-4">
          <TablesView />
          <Button variant="outline" onClick={() => openSection("setup")}>
            {t("Review setup")}
            <ArrowRight />
          </Button>
        </div>
      )}
      {section === "setup" && (
        <div>
          <Panel
            title="Ready to open"
            description="Review your location, staff access, and table rules before enabling new business days."
          >
            {staffError && (
              <Alert variant="destructive">
                <AlertDescription>
                  {t(staffError)}
                  <Button
                    size="sm"
                    variant="outline"
                    onClick={() => setStaffReload((value) => value + 1)}
                  >
                    {t("Retry")}
                  </Button>
                </AlertDescription>
              </Alert>
            )}
            {!staff && !staffError && (
              <p role="status" className="text-sm">
                {t("Loading staff accounts…")}
              </p>
            )}
            {settings.setupCompleted ? (
              <Button asChild>
                <Link href="/reports">
                  {t("Go to business days")}
                  <ArrowRight />
                </Link>
              </Button>
            ) : (
              <Button
                disabled={!ready || s.busy || s.retryRequired}
                onClick={() => void s.submit({ kind: "COMPLETE_SETUP" })}
              >
                {t(s.busy ? "Saving…" : "Complete setup")}
              </Button>
            )}
          </Panel>
        </div>
      )}
      {section === "locations" && (
        <div>
          <LocationManagement />
        </div>
      )}
      {editor && (
        <VenueSettingsDialog
          key={editor}
          section={editor}
          onClose={() => setEditor(null)}
        />
      )}
    </div>
  );
}

function LocationManagement() {
  const s = usePokerManagementContext(),
    t = useText();
  const { branches, switchBranch } = useAuth();
  const [open, setOpen] = useState(false);
  const [name, setName] = useState("");
  const [code, setCode] = useState("");
  const [timezone, setTimezone] = useState("Asia/Kuala_Lumpur");
  const [switching, setSwitching] = useState("");
  const [search, setSearch] = useState("");
  const [role, setRole] = useState("ALL");
  const [currentPage, setPage] = useState(0);
  const query = search.trim().toLowerCase();
  const locations = branches.filter(
    (branch) =>
      (role === "ALL" || branch.role === role) &&
      [branch.name, branch.id, branch.timezone, t(branch.role)].some((value) =>
        value.toLowerCase().includes(query),
      ),
  );
  const page = Math.min(
    currentPage,
    Math.max(0, Math.ceil(locations.length / 20) - 1),
  );
  const clearFilters = () => {
    setSearch("");
    setRole("ALL");
    setPage(0);
  };
  return (
    <>
      <Panel
        title="Locations"
        description="Each location has its own staff roles, tables, operating rules, and records."
        action={
          <Button
            onClick={() => {
              setName("");
              setCode("");
              setTimezone("Asia/Kuala_Lumpur");
              s.setError("");
              setOpen(true);
            }}
          >
            <Plus />
            {t("Add location")}
          </Button>
        }
      >
        <ListToolbar
          search={search}
          searchLabel="Search locations"
          searchPlaceholder="Location name, code, or time zone"
          onSearchChange={(value) => {
            setSearch(value);
            setPage(0);
          }}
          activeFilters={
            role === "ALL"
              ? []
              : [
                  {
                    key: "role",
                    label: t("Your role") + ": " + t(role),
                    onRemove: () => {
                      setRole("ALL");
                      setPage(0);
                    },
                  },
                ]
          }
          onClear={clearFilters}
          resultCount={locations.length}
        >
          <Field label="Your role">
            <Select
              value={role}
              onValueChange={(value) => {
                setRole(value);
                setPage(0);
              }}
              options={[
                { value: "ALL", label: "All roles" },
                ...["DEALER", "CASHIER", "MANAGER", "ADMIN"].map((value) => ({
                  value,
                  label: value,
                })),
              ]}
            />
          </Field>
        </ListToolbar>
        {!locations.length && (
          <EmptyState
            title="No matching locations"
            description="Try another location name or clear your filters."
          >
            {(query || role !== "ALL") && (
              <Button variant="outline" onClick={clearFilters}>
                {t("Clear all")}
              </Button>
            )}
          </EmptyState>
        )}
        <ul className="space-y-3">
          {locations.slice(page * 20, page * 20 + 20).map((branch) => (
            <li
              key={branch.id}
              className="flex min-w-0 flex-wrap items-center gap-3 rounded-lg border p-4"
            >
              <div className="flex min-w-0 flex-1 items-start gap-3">
                <Building2 className="size-5 shrink-0 text-muted-foreground" />
                <div className="min-w-0">
                  <p className="break-words font-medium">
                    {displayName(branch.name)}
                  </p>
                  <p className="break-words text-xs text-muted-foreground">
                    {branch.id} · {branch.timezone} · {t(branch.role)}
                  </p>
                </div>
              </div>
              {branch.id === s.snapshot!.branch.id ? (
                <Badge>{t("Current location")}</Badge>
              ) : (
                <Button
                  size="sm"
                  variant="outline"
                  className="h-11 w-full sm:h-9 sm:w-auto"
                  aria-label={
                    t("Open location") + " · " + displayName(branch.name)
                  }
                  disabled={!!switching || s.busy || s.retryRequired}
                  onClick={async () => {
                    setSwitching(branch.id);
                    try {
                      await switchBranch(branch.id);
                    } catch (e) {
                      s.setError(
                        e instanceof Error ? e.message : "Request failed.",
                      );
                      setSwitching("");
                    }
                  }}
                >
                  {t(switching === branch.id ? "Loading…" : "Open location")}
                </Button>
              )}
            </li>
          ))}
        </ul>
        <Pager
          page={page}
          total={locations.length}
          setPage={setPage}
          label="Location pagination"
        />
      </Panel>
      <Modal
        open={open}
        onOpenChange={setOpen}
        title="Add location"
        description="Create an empty venue. You will have admin access and can complete its setup after switching to it."
      >
        <ActionForm
          onSubmit={() =>
            s.submitLocation({
              kind: "CREATE_LOCATION",
              id: code,
              name,
              timezone,
            })
          }
          onSuccess={() => setOpen(false)}
        >
          <FormSection
            title="Location details"
            description="Choose a recognizable name and a unique code for this venue."
          >
            <FormGrid>
              <Field label="Venue name">
                <Input
                  required
                  maxLength={200}
                  placeholder={t("For example, Main venue")}
                  autoComplete="organization"
                  value={name}
                  onChange={(e) => setName(e.target.value)}
                />
              </Field>
              <Field
                label="Location code"
                hint="Use 3–50 lowercase letters, numbers, or hyphens. Start and end with a letter or number."
              >
                <Input
                  required
                  minLength={3}
                  maxLength={50}
                  placeholder="kl-central"
                  autoCapitalize="none"
                  autoComplete="off"
                  spellCheck={false}
                  value={code}
                  onChange={(e) => setCode(e.target.value.toLowerCase())}
                />
              </Field>
            </FormGrid>
          </FormSection>
          <FormSection
            title="Business clock"
            description="The location time zone determines business dates and timestamps."
          >
            <Field label="Time zone" hint="For example, Asia/Kuala_Lumpur.">
              <Input
                required
                maxLength={100}
                placeholder="Asia/Kuala_Lumpur"
                autoComplete="off"
                spellCheck={false}
                value={timezone}
                onChange={(e) => setTimezone(e.target.value)}
              />
            </Field>
          </FormSection>
          <FormActions>Create location</FormActions>
        </ActionForm>
      </Modal>
    </>
  );
}
