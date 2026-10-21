"use client";
import { useEffect, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Role } from "@/domain/model";
import type { StaffAccount, StaffCommand } from "@/domain/staff";
import { displayName } from "@/lib/display-name";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { RecordList } from "./record-list";
import { ListToolbar } from "./list-toolbar";
import { RowActions, type RowAction } from "./row-actions";
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
} from "./shared";

type Edit = {
  action: "create" | "role" | "password" | "disable";
  account?: StaffAccount;
};
const roleHelp: Record<Role, string> = {
  DEALER: "Dealers submit table income and payout requests.",
  CASHIER:
    "Cashiers check in players, manage seats, and request cash transactions.",
  MANAGER:
    "Managers also review ordinary requests and manage tables, profiles, and business days.",
  ADMIN:
    "Admins also manage staff, review high-value requests, and reopen business days.",
};
export function StaffManagement() {
  const s = usePokerManagementContext(),
    t = useText();
  const [accounts, setAccounts] = useState<StaffAccount[] | null>(null);
  const [error, setError] = useState("");
  const [reload, setReload] = useState(0);
  const [query, setQuery] = useState("");
  const [filter, setFilter] = useState("active");
  const [roleFilter, setRoleFilter] = useState("");
  const [requestedPage, setPage] = useState(0);
  const [edit, setEdit] = useState<Edit | null>(null);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("CASHIER");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const branchId = s.snapshot!.branch.id;
  useEffect(() => {
    const controller = new AbortController();
    void fetch("/api/staff", { cache: "no-store", signal: controller.signal })
      .then(async (response) => {
        const data = await response.json();
        if (!response.ok) throw new Error(data.error);
        if (data.branchId !== branchId)
          throw new Error(
            "Your active branch changed. Reload this page before continuing.",
          );
        setAccounts(data.accounts);
        setError("");
      })
      .catch((e: unknown) => {
        if (!controller.signal.aborted)
          setError(
            e instanceof Error ? e.message : "Cannot load staff accounts.",
          );
      });
    return () => controller.abort();
  }, [branchId, s.snapshot?.revision, reload]);
  function start(next: Edit) {
    s.setError("");
    setUsername("");
    setPassword("");
    setConfirm("");
    setReason("");
    setRole(next.account?.role ?? "CASHIER");
    setEdit(next);
  }
  const title =
    edit?.action === "create"
      ? "Create staff account"
      : edit?.action === "role"
        ? "Change role"
        : edit?.action === "disable"
          ? "Disable account"
          : edit?.account?.active
            ? "Reset password"
            : "Enable account";
  const needsPassword =
    edit?.action === "create" || edit?.action === "password";
  async function save() {
    if (!edit) return false;
    if (needsPassword && password !== confirm)
      throw new Error("Passwords do not match.");
    let command: StaffCommand;
    if (edit.action === "create")
      command = { kind: "STAFF_CREATE", username, password, role, reason };
    else if (edit.action === "role")
      command = { kind: "STAFF_ROLE", userId: edit.account!.id, role, reason };
    else if (edit.action === "disable")
      command = { kind: "STAFF_DISABLE", userId: edit.account!.id, reason };
    else
      command = {
        kind: "STAFF_PASSWORD",
        userId: edit.account!.id,
        password,
        enable: !edit.account!.active,
        reason,
      };
    return s.submitStaff(command);
  }
  const rows = (accounts ?? []).filter(
    (a) =>
      a.username.toLowerCase().includes(query.trim().toLowerCase()) &&
      (filter === "all" || a.active === (filter === "active")) &&
      (!roleFilter || a.role === roleFilter),
  );
  const page = Math.min(
    requestedPage,
    Math.max(0, Math.ceil(rows.length / 20) - 1),
  );
  const clearCriteria = () => {
    setQuery("");
    setFilter("all");
    setRoleFilter("");
    setPage(0);
  };
  function accountActions(account: StaffAccount) {
    if (account.id === s.user?.id)
      return (
        <span className="inline-block max-w-48 text-xs leading-4 text-muted-foreground">
          {t("Ask another admin to change your own account.")}
        </span>
      );
    const blocked = s.busy || s.retryRequired;
    if (account.sharedAccount)
      return (
        <Button
          size="sm"
          variant="outline"
          className="h-11 sm:h-9"
          disabled={blocked}
          aria-label={t("Change role") + " · " + displayName(account.username)}
          onClick={() => start({ action: "role", account })}
        >
          {t("Change role")}
        </Button>
      );
    const actions: RowAction[] = [
      {
        key: "role",
        label: "Change role",
        disabled: blocked,
        onSelect: () => start({ action: "role", account }),
      },
      {
        key: "password",
        label: account.active ? "Reset password" : "Enable account",
        disabled: blocked,
        onSelect: () => start({ action: "password", account }),
      },
    ];
    if (account.active)
      actions.push({
        key: "disable",
        label: "Disable account",
        disabled: blocked,
        destructive: true,
        onSelect: () => start({ action: "disable", account }),
      });
    return (
      <RowActions
        label={t("Staff actions") + " · " + displayName(account.username)}
        actions={actions}
        disabled={blocked}
        iconOnly
      />
    );
  }
  return (
    <>
      <Panel
        title="Staff accounts"
        description="Manage staff access for this location. Every change is recorded in the audit history."
        compact
        action={
          <Button
            size="sm"
            className="size-11 px-0 sm:h-9 sm:w-auto sm:px-3"
            aria-label={t("Create staff account")}
            title={t("Create staff account")}
            disabled={s.busy || s.retryRequired}
            onClick={() => start({ action: "create" })}
          >
            <UserPlus />
            <span className="hidden sm:inline">{t("Create staff account")}</span>
          </Button>
        }
      >
        <ListToolbar
          compact
          search={query}
          searchLabel="Search staff accounts"
          searchPlaceholder="Username"
          onSearchChange={(value) => {
            setQuery(value);
            setPage(0);
          }}
          activeFilters={[
            ...(filter === "all"
              ? []
              : [
                  {
                    key: "status",
                    label:
                      t("Account status") +
                      ": " +
                      t(
                        filter === "active"
                          ? "Enabled accounts"
                          : "Disabled accounts",
                      ),
                    onRemove: () => {
                      setFilter("all");
                      setPage(0);
                    },
                  },
                ]),
            ...(roleFilter
              ? [
                  {
                    key: "role",
                    label: t("Role") + ": " + t(roleFilter),
                    onRemove: () => {
                      setRoleFilter("");
                      setPage(0);
                    },
                  },
                ]
              : []),
          ]}
          onClear={clearCriteria}
          resultCount={rows.length}
        >
          <Field label="Account status">
            <Select
              value={filter}
              onValueChange={(value) => {
                setFilter(value);
                setPage(0);
              }}
              options={[
                { value: "active", label: "Enabled accounts" },
                { value: "disabled", label: "Disabled accounts" },
                { value: "all", label: "All accounts" },
              ]}
            />
          </Field>
          <Field label="Role">
            <Select
              value={roleFilter}
              onValueChange={(value) => {
                setRoleFilter(value);
                setPage(0);
              }}
              options={[
                { value: "", label: "All roles" },
                ...Object.keys(roleHelp).map((value) => ({
                  value,
                  label: value,
                })),
              ]}
            />
          </Field>
        </ListToolbar>
        {rows.some((account) => account.sharedAccount && account.id !== s.user?.id) && (
          <p className="text-xs leading-5 text-muted-foreground">
            <span className="font-medium">{t("Multiple locations")}: </span>
            {t(
              "Password and account access are managed with the operator commands.",
            )}
          </p>
        )}
        {error ? (
          <Alert variant="destructive">
            <AlertDescription>
              {t(error)}
              <Button
                variant="outline"
                size="sm"
                onClick={() => setReload((v) => v + 1)}
              >
                {t("Retry")}
              </Button>
            </AlertDescription>
          </Alert>
        ) : !accounts ? (
          <p role="status" className="text-sm text-muted-foreground">
            {t("Loading staff accounts…")}
          </p>
        ) : !rows.length ? (
          <EmptyState
            title={
              accounts.length
                ? "No matching staff accounts"
                : "No staff accounts yet"
            }
            description={
              accounts.length
                ? "Try another search or clear the filters."
                : "Create a staff account to give someone access to this location."
            }
          >
            {accounts.length > 0 && (
              <Button variant="outline" onClick={clearCriteria}>
                {t("Clear all")}
              </Button>
            )}
          </EmptyState>
        ) : (
          <RecordList
            label="Staff accounts"
            compact
            rows={rows.slice(page * 20, page * 20 + 20)}
            rowKey={(a) => a.id}
            columns={[
              {
                label: "Username",
                render: (a) => (
                  <div className="min-w-0 space-y-0.5">
                    <div className="flex min-w-0 flex-wrap items-baseline gap-x-2 gap-y-0.5">
                      <span className="min-w-0 font-medium [overflow-wrap:anywhere]">
                        {displayName(a.username)}
                      </span>
                      {a.id === s.user?.id && (
                        <span className="text-xs font-normal text-muted-foreground">
                          ({t("You")})
                        </span>
                      )}
                    </div>
                    {a.sharedAccount && (
                      <p className="text-xs font-normal leading-4 text-muted-foreground">
                        {t("Multiple locations")}
                      </p>
                    )}
                  </div>
                ),
              },
              { label: "Role", render: (a) => t(a.role) },
              {
                label: "Status",
                render: (a) => (
                  <Badge tone={a.active ? "green" : "neutral"}>
                    {a.active ? "Enabled" : "Disabled"}
                  </Badge>
                ),
              },
              {
                label: "Actions",
                actions: true,
                render: accountActions,
              },
            ]}
          />
        )}
        {accounts && !error && (
          <Pager
            label="Staff account pages"
            page={page}
            total={rows.length}
            setPage={setPage}
          />
        )}
      </Panel>
      <Modal
        open={!!edit}
        onOpenChange={(open) => {
          if (!open) {
            setEdit(null);
            setPassword("");
            setConfirm("");
          }
        }}
        title={title}
        description={
          edit?.action === "create"
            ? "Create a login for this location and share its password privately with the staff member."
            : displayName(edit?.account?.username ?? "") +
              " · " +
              t("Existing sessions will be signed out after this change.")
        }
      >
        <ActionForm
          onSubmit={save}
          onSuccess={() => {
            setEdit(null);
            setPassword("");
            setConfirm("");
          }}
        >
          {(edit?.action === "create" || edit?.action === "role") && (
            <FormSection title="Account access">
              <FormGrid
                className={
                  edit?.action === "role" ? "sm:grid-cols-1" : undefined
                }
              >
                {edit?.action === "create" && (
                  <Field
                    label="Username"
                    hint="Use 3–64 lowercase letters, numbers, dots, underscores, or hyphens."
                  >
                    <Input
                      required
                      minLength={3}
                      maxLength={64}
                      autoComplete="off"
                      autoCapitalize="none"
                      autoCorrect="off"
                      spellCheck={false}
                      placeholder={t("e.g. jane.cashier")}
                      value={username}
                      onChange={(e) =>
                        setUsername(e.target.value.toLowerCase())
                      }
                    />
                  </Field>
                )}
                <Field label="Role" hint={roleHelp[role]}>
                  <Select
                    required
                    value={role}
                    onValueChange={(v) => setRole(v as Role)}
                    options={Object.keys(roleHelp).map((value) => ({
                      value,
                      label: value,
                    }))}
                  />
                </Field>
              </FormGrid>
            </FormSection>
          )}
          {needsPassword && (
            <FormSection
              title="Sign-in password"
              description="Use 12–128 characters. Share the password privately."
            >
              <FormGrid>
                <Field label="New password">
                  <PasswordInput
                    showLabel={t("Show password") + " · " + t("New password")}
                    hideLabel={t("Hide password") + " · " + t("New password")}
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={password}
                    onChange={(e) => setPassword(e.target.value)}
                  />
                </Field>
                <Field label="Confirm password">
                  <PasswordInput
                    showLabel={
                      t("Show password") + " · " + t("Confirm password")
                    }
                    hideLabel={
                      t("Hide password") + " · " + t("Confirm password")
                    }
                    autoComplete="new-password"
                    required
                    minLength={12}
                    maxLength={128}
                    value={confirm}
                    onChange={(e) => setConfirm(e.target.value)}
                  />
                </Field>
              </FormGrid>
            </FormSection>
          )}
          {edit?.action === "disable" && (
            <Alert>
              <AlertDescription>
                {t(
                  "This staff member will lose access immediately. Their past transactions and audit history remain available.",
                )}
              </AlertDescription>
            </Alert>
          )}
          <Field
            label="Reason for change"
            hint="Explain this access change for the audit history."
          >
            <Textarea
              required
              minLength={3}
              maxLength={500}
              value={reason}
              onChange={(e) => setReason(e.target.value)}
            />
          </Field>
          <FormActions destructive={edit?.action === "disable"}>
            {title}
          </FormActions>
        </ActionForm>
      </Modal>
    </>
  );
}
