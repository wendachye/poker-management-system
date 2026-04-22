import { ManagementShell } from "@/components/layout/management-shell";

export default function ReportsLayout({ children }: { children: React.ReactNode }) {
  return <ManagementShell>{children}</ManagementShell>;
}
