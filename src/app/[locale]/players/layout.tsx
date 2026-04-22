import { ManagementShell } from "@/components/layout/management-shell";

export default function PlayersLayout({ children }: { children: React.ReactNode }) {
  return <ManagementShell>{children}</ManagementShell>;
}
