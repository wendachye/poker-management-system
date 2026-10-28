"use client";

import { useId, useState } from "react";
import {
  ChevronsUpDown,
  LoaderCircle,
  LogOut,
  Presentation,
} from "lucide-react";
import { prototypeEnabled } from "@/prototype/config";
import { useAuth } from "@/contexts/auth-context";
import { displayName } from "@/lib/display-name";
import { useText } from "@/components/page/PokerManagementPage/components/shared";
import { usePokerManagementContext } from "@/components/page/PokerManagementPage/PokerManagementProvider";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import {
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";

export function NavUser() {
  const { user, logout } = useAuth();
  const management = usePokerManagementContext();
  const navigationHelpId = useId();
  const { isMobile } = useSidebar();
  const t = useText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
  const navigationBlock = management.retryRequired
    ? "Retry the unconfirmed request before switching venues or signing out."
    : management.busy
      ? "Wait for the current request to finish before switching venues or signing out."
      : "";

  if (!user) return null;

  async function signOut() {
    if (busy || navigationBlock) {
      if (navigationBlock) setError(navigationBlock);
      return;
    }
    setBusy(true);
    setError("");
    try {
      await logout();
    } catch (error) {
      setError(
        error instanceof Error
          ? error.message
          : "Could not sign out. Please try again.",
      );
    } finally {
      setBusy(false);
    }
  }

  return (
    <SidebarMenu>
      <SidebarMenuItem>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <SidebarMenuButton
              size="lg"
              tooltip={t("Account menu")}
              aria-label={t("Account menu")}
              disabled={busy}
              className="data-[state=open]:bg-sidebar-accent data-[state=open]:text-sidebar-accent-foreground"
            >
              <span
                className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-muted text-xs font-semibold text-foreground"
                aria-hidden="true"
              >
                {displayName(user.username).slice(0, 2).toUpperCase()}
              </span>
              <div className="grid min-w-0 flex-1 text-left text-sm leading-tight">
                <span className="truncate font-semibold">
                  {displayName(user.username)}
                </span>
                <span className="truncate text-xs text-muted-foreground">
                  {t(user.role)}
                </span>
              </div>
              <ChevronsUpDown className="ml-auto size-4" />
            </SidebarMenuButton>
          </DropdownMenuTrigger>
          <DropdownMenuContent
            className="min-w-56"
            side={isMobile ? "top" : "right"}
            align="end"
            sideOffset={4}
          >
            <DropdownMenuLabel>
              {displayName(user.username)}
              <p className="text-xs font-normal text-muted-foreground">
                {t(user.role)}
              </p>
            </DropdownMenuLabel>
            <DropdownMenuSeparator />
            {navigationBlock && (
              <p
                id={navigationHelpId}
                role="status"
                className="max-w-64 px-2 py-2 text-xs leading-5 text-muted-foreground"
              >
                {t(navigationBlock)}
              </p>
            )}
            {error && (
              <Alert variant="destructive" className="mb-1 max-w-72">
                <AlertDescription>{t(error)}</AlertDescription>
              </Alert>
            )}
            <DropdownMenuItem
              disabled={busy || !!navigationBlock}
              aria-describedby={navigationBlock ? navigationHelpId : undefined}
              onSelect={(event) => {
                event.preventDefault();
                void signOut();
              }}
            >
              {busy ? (
                <LoaderCircle className="animate-spin" />
              ) : prototypeEnabled ? (
                <Presentation />
              ) : (
                <LogOut />
              )}
              {t(prototypeEnabled ? "Demo overview" : "Sign out")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
