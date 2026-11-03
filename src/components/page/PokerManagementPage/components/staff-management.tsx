"use client";
import { useEffect, useRef, useState } from "react";
import { UserPlus } from "lucide-react";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { PasswordInput } from "@/components/ui/password-input";
import { Textarea } from "@/components/ui/textarea";
import { Alert, AlertDescription } from "@/components/ui/alert";
import type { Role } from "@/domain/model";
import type { StaffAccount, StaffListResult } from "@/domain/staff";
import { displayName } from "@/lib/display-name";
import { matchesListSearch } from "@/lib/list-search";
import { managementJson } from "@/lib/management-request";
import { staffReceipt } from "@/lib/management-contracts";
import {
  staffFormCommand,
  type StaffFormAction,
} from "@/lib/staff-form-command";
import { prototypeEnabled } from "@/prototype/config";
import { usePokerManagementContext } from "../PokerManagementProvider";
import { RecordList } from "./record-list";
import { ListToolbar } from "./list-toolbar";
import { QuickFilters } from "./quick-filters";
import { useListBrowsing } from "./use-list-browsing";
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
  action: StaffFormAction;
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
  const [result, setResult] = useState<{
    key: string;
    data: StaffListResult;
  } | null>(null);
  const [failure, setFailure] = useState<{
    key: string;
    message: string;
  } | null>(null);
  const [reload, setReload] = useState(0);
  const browsing = useListBrowsing("staff", "staff");
  const query = s.draft("staff.search");
  const filter = s.draft("staff.status", "active");
  const roleFilter = s.draft("staff.role");
  const requestedPage = Math.max(0, Number(s.draft("staff.page", "0")) || 0);
  const setQuery = (value: string) => s.setDraft("staff.search", value);
  const setFilter = (value: string) => s.setDraft("staff.status", value);
  const setRoleFilter = (value: string) => s.setDraft("staff.role", value);
  const setPage = (value: number) => s.setDraft("staff.page", String(value));
  const [edit, setEdit] = useState<Edit | null>(null);
  const [username, setUsername] = useState("");
  const [role, setRole] = useState<Role>("CASHIER");
  const [password, setPassword] = useState("");
  const [confirm, setConfirm] = useState("");
  const [reason, setReason] = useState("");
  const branchId = s.snapshot!.branch.id;
  const previousSearch = useRef<{
    identity: string;
    criteria: string;
    query: string;
  } | null>(null);
  const params = new URLSearchParams({
    query,
    status: filter,
    ...(roleFilter ? { role: roleFilter } : {}),
    page: String(requestedPage),
    pageSize: String(browsing.pageSize),
    ...Object.fromEntries(
      Object.entries(browsing.query).filter(([key]) => key !== "pageSize"),
    ),
  }).toString();
  const requestKey = JSON.stringify([
    branchId,
    s.user?.id,
    s.user?.role,
    params,
  ]);
  const error = failure?.key === requestKey ? failure.message : "";
  const current = !error && result?.key === requestKey ? result.data : null;
  const accounts = current?.accounts ?? null;
  const resultsReady = !!accounts && !error;
  const paged = !prototypeEnabled && current?.total !== undefined;
  useEffect(() => {
    const controller = new AbortController();
    const criteria = new URLSearchParams(params);
    const text = criteria.get("query") ?? "";
    criteria.delete("query");
    criteria.delete("page");
    const identity = JSON.stringify([
      branchId,
      s.user?.id,
      s.user?.role,
      s.snapshot?.revision,
      reload,
    ]);
    const previous = previousSearch.current;
    const delay =
      text.trim() &&
      previous?.identity === identity &&
      previous.criteria === criteria.toString() &&
      previous.query !== text
        ? 200
        : 0;
    previousSearch.current = {
      identity,
      criteria: criteria.toString(),
      query: text,
    };
    const timer = setTimeout(() => {
      setFailure(null);
      void managementJson<unknown>("/api/staff?" + params, {
        cache: "no-store",
        signal: controller.signal,
      })
        .then(staffReceipt)
        .then((data) => {
          if (controller.signal.aborted) return;
          if (data.branchId !== branchId)
            throw new Error(
              "Your active branch changed. Reload this page before continuing.",
            );
          setResult({ key: requestKey, data });
          setFailure(null);
        })
        .catch((e: unknown) => {
          if (!controller.signal.aborted) {
            setResult(null);
            setFailure({
              key: requestKey,
              message:
                e instanceof Error ? e.message : "Cannot load staff accounts.",
            });
          }
        });
    }, delay);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [
    branchId,
    requestKey,
    params,
    s.user?.id,
    s.user?.role,
    s.snapshot?.revision,
    reload,
  ]);
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
            ? prototypeEnabled
              ? "Simulate password reset"
              : "Reset password"
            : "Enable account";
  const needsPassword =
    !prototypeEnabled &&
    (edit?.action === "create" || edit?.action === "password");
  async function save() {
    if (!edit) return false;
    return s.submitStaff(
      staffFormCommand(
        {
          ...edit,
          username,
          role,
          password,
          confirmation: confirm,
          reason,
        },
        prototypeEnabled,
      ),
    );
  }
  const matchingAccounts = paged
    ? (accounts ?? [])
    : (accounts ?? []).filter(
        (a) =>
          matchesListSearch(query, [
            a.username,
            displayName(a.username),
            a.role,
            t(a.role),
          ]) &&
          (!roleFilter || a.role === roleFilter),
      );
  const rows = paged
    ? matchingAccounts
    : browsing.sortRows(
        matchingAccounts.filter(
          (a) => filter === "all" || a.active === (filter === "active"),
        ),
      );
  const total = paged ? current!.total! : rows.length;
  const noMatches = !!(
    accounts?.length ||
    query.trim() ||
    roleFilter ||
    filter !== "all"
  );
  const page = paged
    ? current!.page!
    : Math.min(
        requestedPage,
        Math.max(0, Math.ceil(rows.length / browsing.pageSize) - 1),
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
        label: account.active
          ? prototypeEnabled
            ? "Simulate password reset"
            : "Reset password"
          : "Enable account",
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
        description={
          prototypeEnabled
            ? "Manage fictional staff records in this tab. Use Demo role to try the built-in sample accounts. Changes reset when you refresh."
            : "Manage staff access for this location. Every change is recorded in the audit history."
        }
        compact
        action={
          <Button
            size="sm"
            className="h-11 px-3 sm:h-9"
            aria-label={t("Create staff account")}
            title={t("Create staff account")}
            disabled={s.busy || s.retryRequired}
            onClick={() => start({ action: "create" })}
          >
            <UserPlus />
            <span className="sm:hidden">{t("Add staff")}</span>
            <span className="hidden sm:inline">
              {t("Create staff account")}
            </span>
          </Button>
        }
      >
        <QuickFilters
          label="Account status"
          value={filter}
          onValueChange={(value) => {
            setFilter(value);
            setPage(0);
          }}
          options={[
            {
              value: "all",
              label: "All accounts",
              count: !resultsReady
                ? undefined
                : paged
                  ? current!.counts!.ALL
                  : matchingAccounts.length,
            },
            {
              value: "active",
              label: "Enabled",
              count: !resultsReady
                ? undefined
                : paged
                  ? current!.counts!.ACTIVE
                  : matchingAccounts.filter((account) => account.active).length,
            },
            {
              value: "disabled",
              label: "Disabled",
              count: !resultsReady
                ? undefined
                : paged
                  ? current!.counts!.DISABLED
                  : matchingAccounts.filter((account) => !account.active)
                      .length,
            },
          ]}
        />
        <ListToolbar
          compact
          search={query}
          searchLabel="Search staff accounts"
          searchPlaceholder="Username or role"
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
                    hideChip: true,
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
          resultCount={resultsReady ? total : null}
          loading={!resultsReady && !error}
        >
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
        {browsing.controls}
        {rows.some(
          (account) => account.sharedAccount && account.id !== s.user?.id,
        ) && (
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
        ) : !accounts ? null : !rows.length ? (
          <EmptyState
            title={
              noMatches ? "No matching staff accounts" : "No staff accounts yet"
            }
            description={
              noMatches
                ? "Try another search or clear the filters."
                : prototypeEnabled
                  ? "Create a fictional staff record to demonstrate venue setup."
                  : "Create a staff account to give someone access to this location."
            }
          >
            {noMatches && (
              <Button variant="outline" onClick={clearCriteria}>
                {t("Clear all")}
              </Button>
            )}
          </EmptyState>
        ) : (
          <RecordList
            label="Staff accounts"
            compact
            rows={
              paged
                ? rows
                : rows.slice(
                    page * browsing.pageSize,
                    (page + 1) * browsing.pageSize,
                  )
            }
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
        <Pager
          label="Staff account pages"
          page={page}
          total={resultsReady ? total : null}
          loading={!resultsReady && !error}
          setPage={setPage}
          {...browsing.pager}
        />
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
          prototypeEnabled
            ? edit?.action === "create"
              ? "Create a fictional staff record to demonstrate venue setup. Prototype access uses the built-in accounts in Demo role."
              : edit?.action === "password" && edit.account?.active
                ? "Simulate a password reset for this sample record. Prototype access uses Demo role; no password is stored."
                : displayName(edit?.account?.username ?? "") +
                  " · " +
                  t(
                    "This sample change applies only to this tab and resets when you refresh.",
                  )
            : edit?.action === "create"
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
                  prototypeEnabled
                    ? "This sample account will be disabled in the current tab. Its past transactions and audit history remain available."
                    : "This staff member will lose access immediately. Their past transactions and audit history remain available.",
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
