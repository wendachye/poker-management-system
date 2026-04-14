import { LucideIcon } from "lucide-react";

export type NavItem = {
  title: string;
  url: string;
  icon: LucideIcon;
  items?: NavItem[];
  moduleKey?: string;
};
