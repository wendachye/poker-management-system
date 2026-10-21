import { database } from "@/server/database";
import { body, failure, json, sessionToken } from "@/server/http";
import { listStaff, manageStaff } from "@/server/staff";
export const runtime = "nodejs";
export async function GET() {
  try {
    return json(await listStaff(database(), await sessionToken()));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    return json(
      await manageStaff(database(), await sessionToken(), await body(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
