"use client";
import { Spade } from "lucide-react";
import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
  SidebarMenu,
  SidebarMenuButton,
  SidebarMenuItem,
  useSidebar,
} from "@/components/ui/sidebar";
import { adminMenu, navMenu } from "@/config/navigations";
import { useText } from "@/components/page/PokerManagementPage/components/shared";
import { Link } from "@/i18n/navigation";
import { NavMain } from "./nav-main";
import { NavUser } from "./nav-user";

export function AppSidebar() {
  const t = useText();
  const { isMobile, setOpenMobile } = useSidebar();
  return (
    <Sidebar collapsible="icon">
      <SidebarHeader>
        <SidebarMenu>
          <SidebarMenuItem>
            <SidebarMenuButton
              asChild
              size="lg"
              tooltip={t("Poker Management")}
            >
              <Link
                href="/dashboard"
                onClick={() => {
                  if (isMobile) setOpenMobile(false);
                }}
              >
                <div className="flex size-8 shrink-0 items-center justify-center rounded-lg bg-primary text-primary-foreground">
                  <Spade className="size-5" />
                </div>
                <div className="grid min-w-0 flex-1 text-left leading-tight">
                  <span className="truncate font-semibold">
                    {t("Poker Management")}
                  </span>
                  <span className="truncate text-xs text-muted-foreground">
                    {t("Venue operations")}
                  </span>
                </div>
              </Link>
            </SidebarMenuButton>
          </SidebarMenuItem>
        </SidebarMenu>
      </SidebarHeader>
      <SidebarContent>
        <NavMain items={navMenu} />
        <NavMain items={adminMenu} label="Administration" className="mt-auto" />
      </SidebarContent>
      <SidebarFooter className="border-t p-2">
        <NavUser />
      </SidebarFooter>
    </Sidebar>
  );
}
