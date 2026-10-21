"use client";

import { useState } from "react";
import { ChevronsUpDown, LoaderCircle, LogOut } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { displayName } from "@/lib/display-name";
import { useText } from "@/components/page/PokerManagementPage/components/shared";
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
  const { isMobile } = useSidebar();
  const t = useText();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");

  if (!user) return null;

  async function signOut() {
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
            {error && (
              <Alert variant="destructive" className="mb-1 max-w-72">
                <AlertDescription>{t(error)}</AlertDescription>
              </Alert>
            )}
            <DropdownMenuItem
              disabled={busy}
              onSelect={(event) => {
                event.preventDefault();
                void signOut();
              }}
            >
              {busy ? <LoaderCircle className="animate-spin" /> : <LogOut />}
              {t("Sign out")}
            </DropdownMenuItem>
          </DropdownMenuContent>
        </DropdownMenu>
      </SidebarMenuItem>
    </SidebarMenu>
  );
}
