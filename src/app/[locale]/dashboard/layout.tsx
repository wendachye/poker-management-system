import { ManagementShell } from "@/components/layout/management-shell";

export default function DashboardLayout({
  children,
}: {
  children: React.ReactNode;
}) {
  return <ManagementShell>{children}</ManagementShell>;
}
