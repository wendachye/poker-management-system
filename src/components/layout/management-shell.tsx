import { AppSidebar } from "@/components/layout/app-sidebar";
import { DashboardHeader } from "@/components/layout/dashboard-header";
import { PokerManagementProvider } from "@/components/page/PokerManagementPage/PokerManagementProvider";
import { OperationDialogs } from "@/components/page/PokerManagementPage/components/operation-dialogs";
import { SidebarInset, SidebarProvider } from "@/components/ui/sidebar";
import { prototypeEnabled } from "@/prototype/config";
import { PrototypeToolbar } from "@/prototype/prototype-toolbar";
import { StaffAccessBoundary } from "@/components/auth/staff-access-boundary";

export function ManagementShell({ children }: { children: React.ReactNode }) {
  return (
    // Keep the client privacy gate below the server layout's access check.
    <StaffAccessBoundary>
      <PokerManagementProvider>
        <SidebarProvider>
          <AppSidebar />
          <SidebarInset className="min-w-0">
            {prototypeEnabled && <PrototypeToolbar />}
            <DashboardHeader />
            <div className="mx-auto w-full max-w-7xl flex-1 px-4 py-6 sm:px-6 sm:py-7 xl:px-8 xl:py-8">
              {children}
            </div>
          </SidebarInset>
          <OperationDialogs />
        </SidebarProvider>
      </PokerManagementProvider>
    </StaffAccessBoundary>
  );
}
