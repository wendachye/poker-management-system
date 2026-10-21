import { notFound } from "next/navigation";
import PokerManagementPage from "@/components/page/PokerManagementPage";
import { isAdminSection } from "@/config/management-modules";

export default async function AdminModulePage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isAdminSection(section)) notFound();
  return <PokerManagementPage module="admin" section={section} />;
}
