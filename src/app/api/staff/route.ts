import { database } from "@/server/database";
import {
  body,
  failure,
  json,
  prototypeApiResponse,
  sessionToken,
} from "@/server/http";
import { listStaff, manageStaff } from "@/server/staff";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    const parameters = new URL(request.url).searchParams;
    return json(
      await listStaff(
        database(),
        await sessionToken(),
        parameters.size ? Object.fromEntries(parameters) : undefined,
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    return json(
      await manageStaff(database(), await sessionToken(), await body(request), {
        compact: true,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
