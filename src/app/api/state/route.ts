import { database } from "@/server/database";
import {
  body,
  failure,
  json,
  prototypeApiResponse,
  sessionToken,
} from "@/server/http";
import { mutate } from "@/server/repository";
import { readOperationalSnapshot } from "@/server/queries";
import { DomainError } from "@/domain/operations";
export const runtime = "nodejs";
export async function GET(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    const params = new URL(request.url).searchParams;
    const focus = (key: string) => {
      const value = params.get(key);
      if (value && value.length > 100)
        throw new DomainError("Invalid record reference.");
      return value ? [value] : [];
    };
    const token = await sessionToken();
    return json(
      await database().transaction(async (connection) => {
        await connection.query(
          "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
        );
        return readOperationalSnapshot(connection, token, {
          playerIds: focus("playerId"),
          approvalIds: focus("approvalId"),
          transactionIds: focus("receiptId"),
        });
      }),
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
      await mutate(database(), await sessionToken(), await body(request), {
        compact: true,
      }),
    );
  } catch (error) {
    return failure(error);
  }
}
