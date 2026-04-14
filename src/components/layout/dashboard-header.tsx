"use client";

import { Separator } from "@/components/ui/separator";
import { SidebarTrigger } from "@/components/ui/sidebar";
import { useAuth } from "@/contexts/auth-context";

export function DashboardHeader() {
  const { user } = useAuth();

  return (
    <header className="flex h-14 shrink-0 items-center gap-2 border-b px-4">
      <SidebarTrigger className="-ml-1" />
      <Separator orientation="vertical" className="m-2" />
      <div className="flex flex-1 items-center justify-between">
        <h1 className="text-lg font-medium">Dashboard</h1>
        {user && (
          <span className="text-sm text-muted-foreground">
            Welcome, {user.username}
          </span>
        )}
      </div>
    </header>
  );
}
