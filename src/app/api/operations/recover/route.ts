import { database } from "@/server/database";
import {
  body,
  failure,
  json,
  prototypeApiResponse,
  sessionToken,
} from "@/server/http";
import { recoverOperation } from "@/server/operation-recovery";

export const runtime = "nodejs";

export async function POST(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    return json(
      await recoverOperation(
        database(),
        await sessionToken(),
        await body(request),
      ),
    );
  } catch (error) {
    return failure(error);
  }
}
