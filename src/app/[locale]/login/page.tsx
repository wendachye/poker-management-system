import { StaffLoginPage } from "@/components/page/StaffLoginPage";
import { prototypeEnabled } from "@/prototype/config";
import { PrototypeEntry } from "@/prototype/prototype-entry";
import { StaffAccessBoundary } from "@/components/auth/staff-access-boundary";

export default async function LoginPage({
  searchParams,
}: {
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  if (prototypeEnabled) return <PrototypeEntry />;
  const unavailable = (await searchParams).unavailable === "1";
  return (
    <StaffAccessBoundary>
      <StaffLoginPage
        key={unavailable ? "unavailable" : "login"}
        unavailable={unavailable}
      />
    </StaffAccessBoundary>
  );
}
