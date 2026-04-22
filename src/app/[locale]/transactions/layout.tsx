import { ManagementShell } from "@/components/layout/management-shell";

export default function TransactionsLayout({ children }: { children: React.ReactNode }) {
  return <ManagementShell>{children}</ManagementShell>;
}
