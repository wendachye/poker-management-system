import { NavItem } from "@/types/navigation";
import {
  ChartNoAxesCombined,
  HandCoins,
  LayoutDashboard,
  Table2,
  UserRoundCog,
  UsersRound,
} from "lucide-react";
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
    icon: UsersRound,
    moduleKey: "players",
  },
  {
    title: "Tables",
    url: ROUTES.TABLES,
    icon: Table2,
    moduleKey: "tables",
  },
  {
    title: "Transactions",
    url: ROUTES.TRANSACTIONS,
    icon: HandCoins,
    moduleKey: "transactions",
  },
  {
    title: "Reports",
    url: ROUTES.REPORTS,
    icon: ChartNoAxesCombined,
    moduleKey: "reports",
  },
  {
    title: "Admin",
    url: ROUTES.ADMIN,
    icon: UserRoundCog,
    moduleKey: "admin",
  },
];
