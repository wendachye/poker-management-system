import { ManagementShell } from "@/components/layout/management-shell";

export default function AdminLayout({ children }: { children: React.ReactNode }) {
  return <ManagementShell>{children}</ManagementShell>;
}
