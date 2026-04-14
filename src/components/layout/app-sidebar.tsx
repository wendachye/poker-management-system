"use client";

import {
  Sidebar,
  SidebarContent,
  SidebarFooter,
  SidebarHeader,
} from "@/components/ui/sidebar";
import { navMenu } from "@/config/navigations";
import { NavMain } from "./nav-main";

export function AppSidebar() {
  // const pathname = usePathname();

  // const isActive = (url: string) => pathname.startsWith(url);

  return (
    <Sidebar>
      <SidebarHeader />
      <SidebarContent>
        <NavMain items={navMenu} />
      </SidebarContent>
      <SidebarFooter />
    </Sidebar>
  );
}
