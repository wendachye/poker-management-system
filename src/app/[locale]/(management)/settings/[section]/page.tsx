import { notFound } from "next/navigation";
import PokerManagementPage from "@/components/page/PokerManagementPage";
import { isSettingsSection } from "@/config/management-modules";

export default async function SettingsModulePage({
  params,
}: {
  params: Promise<{ section: string }>;
}) {
  const { section } = await params;
  if (!isSettingsSection(section)) notFound();
  return <PokerManagementPage module="settings" section={section} />;
}
