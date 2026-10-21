import { redirect } from "next/navigation";
import { ManagementShell } from "@/components/layout/management-shell";
import { sessionUser } from "@/server/auth";
import { database } from "@/server/database";
import { sessionToken } from "@/server/http";
export default async function ManagementLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ locale: string }>;
}) {
  const { locale } = await params;
  const token = await sessionToken();
  if (!token) redirect("/" + locale + "/login");
  let authenticated = false;
  try {
    authenticated = Boolean(await sessionUser(database(), token));
  } catch {
    redirect("/" + locale + "/login?unavailable=1");
  }
  if (!authenticated) redirect("/" + locale + "/login");
  return <ManagementShell>{children}</ManagementShell>;
}
