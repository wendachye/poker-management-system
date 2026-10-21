import { NavItem } from "@/types/navigation";
import {
  ChartNoAxesCombined,
  HandCoins,
  LayoutDashboard,
  Table2,
  UserRoundCog,
  ShieldCheck,
  UsersRound,
  Settings2,
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
];

export const adminMenu: NavItem[] = [
  {
    title: "Venue settings",
    url: `${ROUTES.SETTINGS}/venue`,
    icon: Settings2,
    moduleKey: "settings",
    items: [
      {
        title: "Venue and rules",
        url: `${ROUTES.SETTINGS}/venue`,
        icon: Settings2,
      },
      {
        title: "Tables and stakes",
        url: `${ROUTES.SETTINGS}/tables`,
        icon: Table2,
      },
      {
        title: "Locations",
        url: `${ROUTES.SETTINGS}/locations`,
        icon: Settings2,
      },
      {
        title: "Setup checklist",
        url: `${ROUTES.SETTINGS}/setup`,
        icon: Settings2,
      },
    ],
  },
  {
    title: "Staff accounts",
    url: `${ROUTES.SETTINGS}/staff`,
    icon: UserRoundCog,
    moduleKey: "settings",
  },
  {
    title: "Controls and audit",
    url: `${ROUTES.ADMIN}/audit`,
    icon: ShieldCheck,
    moduleKey: "admin",
    items: [
      {
        title: "Audit history",
        url: `${ROUTES.ADMIN}/audit`,
        icon: ShieldCheck,
      },
      {
        title: "Approval policy",
        url: `${ROUTES.ADMIN}/policy`,
        icon: ShieldCheck,
      },
      {
        title: "Day recovery",
        url: `${ROUTES.ADMIN}/recovery`,
        icon: ShieldCheck,
        moduleKey: "settings",
      },
    ],
  },
];
