import { database } from "@/server/database";
import { body, failure, json, sessionToken } from "@/server/http";
import { createLocation, listLocations } from "@/server/locations";
export const runtime = "nodejs";
export async function GET() {
  try {
    return json(await listLocations(database(), await sessionToken()));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    return json(
      await createLocation(
        database(),
        await sessionToken(),
        await body(request),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
