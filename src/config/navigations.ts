import { NavItem } from "@/types/navigation";
import { Handshake, LayoutDashboard, Package, Settings } from "lucide-react";
import { ROUTES } from "./routes";

export const navMenu: NavItem[] = [
  {
    title: "Dashboard",
    url: ROUTES.DASHBOARD,
    icon: LayoutDashboard,
    moduleKey: "dashboard",
  },
  {
    title: "Players",
    url: ROUTES.PLAYERS,
    icon: Package,
    moduleKey: "players",
  },
  {
    title: "Tables",
    url: ROUTES.TABLES,
    icon: Handshake,
    moduleKey: "tables",
  },
  {
    title: "Transactions",
    url: ROUTES.TRANSACTIONS,
    icon: Handshake,
    moduleKey: "transactions",
  },
  {
    title: "Reports",
    url: ROUTES.REPORTS,
    icon: Handshake,
    moduleKey: "reports",
  },
  {
    title: "Settings",
    url: ROUTES.SETTINGS,
    icon: Settings,
    moduleKey: "settings",
  },
];
