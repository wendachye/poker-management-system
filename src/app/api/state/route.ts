import { database } from "@/server/database";
import { body, failure, json, sessionToken } from "@/server/http";
import { mutate, readSnapshot } from "@/server/repository";
export const runtime = "nodejs";
export async function GET() {
  try {
    return json(await readSnapshot(database(), await sessionToken()));
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  try {
    return json(
      await mutate(database(), await sessionToken(), await body(request)),
    );
  } catch (error) {
    return failure(error);
  }
}
