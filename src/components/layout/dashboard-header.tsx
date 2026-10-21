"use client";
import { useRef, useState } from "react";
import { ChevronRight } from "lucide-react";
import { Button } from "@/components/ui/button";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { Separator } from "@/components/ui/separator";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  AlertDialog,
  AlertDialogContent,
  AlertDialogHeader,
  AlertDialogTitle,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogCancel,
} from "@/components/ui/alert-dialog";
import { useAuth } from "@/contexts/auth-context";
import { adminMenu, navMenu } from "@/config/navigations";
import { Link, usePathname } from "@/i18n/navigation";
import type { NavItem } from "@/types/navigation";
import { displayName } from "@/lib/display-name";
import {
  Select,
  useText,
} from "@/components/page/PokerManagementPage/components/shared";
import { LanguageSwitcher } from "./language-switcher";
import { ApprovalNotifications } from "./approval-notifications";

function navigationTrail(items: NavItem[], pathname: string): NavItem[] {
  let best: NavItem[] = [];
  for (const item of items) {
    const childTrail = navigationTrail(item.items ?? [], pathname);
    const candidate = childTrail.length
      ? [item, ...childTrail]
      : pathname === item.url || pathname.startsWith(`${item.url}/`)
        ? [item]
        : [];
    const candidateUrl = candidate.at(-1)?.url ?? "";
    const bestUrl = best.at(-1)?.url ?? "";
    if (
      candidateUrl.length > bestUrl.length ||
      (candidateUrl.length === bestUrl.length && candidate.length > best.length)
    ) {
      best = candidate;
    }
  }
  return best;
}

export function DashboardHeader() {
  const branchDialog = useRef<HTMLDivElement>(null);
  const { user, branches, switchBranch } = useAuth(),
    t = useText();
  const pathname = usePathname();
  const trail = navigationTrail([...navMenu, ...adminMenu], pathname).filter(
    (item, index, items) =>
      index === 0 || item.title !== items[index - 1].title,
  );
  const currentPage = trail.at(-1);
  const [error, setError] = useState(""),
    [busy, setBusy] = useState(false),
    [pendingBranch, setPendingBranch] = useState("");
  async function run(action: () => Promise<void>) {
    setBusy(true);
    setError("");
    try {
      await action();
    } catch (error) {
      setError(error instanceof Error ? error.message : "Request failed.");
      setBusy(false);
    }
  }
  return (
    <header className="sticky top-0 z-30 flex h-14 shrink-0 items-center gap-1.5 border-b bg-background px-3 sm:gap-2 sm:px-4">
      <SidebarTrigger className="size-10" aria-label={t("Toggle sidebar")} />
      <Separator
        orientation="vertical"
        className="mx-1 hidden !h-4 data-vertical:self-center sm:block"
      />
      <nav aria-label={t("Breadcrumb")} className="hidden min-w-0 sm:block">
        <ol className="flex min-w-0 items-center gap-2 text-sm">
          {pathname !== "/dashboard" && (
            <>
              <li className="hidden xl:block">
                <Link
                  href="/dashboard"
                  className="text-muted-foreground transition-colors hover:text-foreground"
                >
                  {t("Dashboard")}
                </Link>
              </li>
              <li className="hidden xl:block" aria-hidden="true">
                <ChevronRight className="size-3.5 text-muted-foreground" />
              </li>
            </>
          )}
          {trail.slice(0, -1).map((item) => (
            <li
              key={item.url}
              className="hidden min-w-0 items-center gap-2 lg:flex"
            >
              <Link
                href={item.url}
                className="max-w-40 truncate text-muted-foreground transition-colors hover:text-foreground"
              >
                {t(item.title)}
              </Link>
              <ChevronRight
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            </li>
          ))}
          <li className="truncate font-medium" aria-current="page">
            {t(currentPage?.title ?? "Dashboard")}
          </li>
        </ol>
      </nav>
      <div className="ml-auto w-28 min-w-0 sm:w-40">
        {branches.length > 0 && (
          <Select
            aria-label={t("Branch")}
            value={user?.branchId ?? ""}
            onValueChange={(v) => {
              if (v !== user?.branchId) {
                setError("");
                setPendingBranch(v);
              }
            }}
            disabled={busy}
            options={branches.map((b) => ({
              value: b.id,
              label: displayName(b.name),
            }))}
          />
        )}
      </div>
      <LanguageSwitcher />
      <ApprovalNotifications />
      <AlertDialog
        open={!!pendingBranch}
        onOpenChange={(open) => {
          if (!busy && !open) setPendingBranch("");
        }}
      >
        <AlertDialogContent
          ref={branchDialog}
          onOpenAutoFocus={(event) => {
            event.preventDefault();
            branchDialog.current?.focus();
          }}
        >
          <AlertDialogHeader>
            <AlertDialogTitle>{t("Switch branch")}</AlertDialogTitle>
            <AlertDialogDescription>
              {t("Switch branches? Unsubmitted drafts will be cleared.")}{" "}
              {displayName(
                branches.find((b) => b.id === pendingBranch)?.name ?? "",
              )}
            </AlertDialogDescription>
          </AlertDialogHeader>
          {error && (
            <Alert variant="destructive">
              <AlertDescription>{t(error)}</AlertDescription>
            </Alert>
          )}
          <AlertDialogFooter>
            <AlertDialogCancel disabled={busy}>{t("Cancel")}</AlertDialogCancel>
            <Button
              disabled={busy}
              onClick={() => void run(() => switchBranch(pendingBranch))}
            >
              {t(busy ? "Saving…" : "Switch branch")}
            </Button>
          </AlertDialogFooter>
        </AlertDialogContent>
      </AlertDialog>
    </header>
  );
}
