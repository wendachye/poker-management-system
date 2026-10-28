import { createReadinessService } from "@/server/readiness";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";
const readinessResponse = createReadinessService();

export async function GET() {
  return readinessResponse();
}
