"use client";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { navMenu } from "@/config/navigations";
import { useAuth } from "@/contexts/auth-context";
import { usePathname } from "@/i18n/navigation";

export function DashboardHeader() {
  const { user } = useAuth();
  const pathname = usePathname();
  const currentItem =
    navMenu.find((item) => pathname === item.url) ||
    navMenu.find((item) => pathname.startsWith(`${item.url}/`));
  const title = currentItem?.title || "Dashboard";

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-3 sm:px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="m-2" />
      <div className="flex min-w-0 flex-1 items-center justify-between gap-3">
        <h1 className="truncate text-base font-medium sm:text-lg">{title}</h1>
        {user && (
          <span className="hidden shrink-0 text-sm text-muted-foreground sm:inline">
            Welcome, {user.username}
          </span>
        )}
      </div>
    </header>
  );
}
