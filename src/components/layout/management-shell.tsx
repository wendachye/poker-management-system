import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { PokerManagementProvider } from "@/components/page/PokerManagementPage/PokerManagementProvider";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";

export function ManagementShell({ children }: { children: React.ReactNode }) {
  return (
    <PokerManagementProvider>
      <SidebarProvider>
        <AppSidebar />
        <SidebarInset>
          <DashboardHeader />
          <main className="flex-1 overflow-x-hidden p-3 sm:p-4">
            {children}
          </main>
        </SidebarInset>
      </SidebarProvider>
    </PokerManagementProvider>
  );
}
