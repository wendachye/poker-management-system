import { z } from "zod";
import { changeBranch } from "@/server/auth";
import { database } from "@/server/database";
import {
  body,
  failure,
  json,
  prototypeApiResponse,
  sessionToken,
} from "@/server/http";
import { DomainError } from "@/domain/operations";
export const runtime = "nodejs";
export async function POST(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    const parsed = z
      .object({ branchId: z.string().min(1).max(100) })
      .strict()
      .safeParse(await body(request));
    if (!parsed.success) throw new DomainError("Select a branch.");
    await changeBranch(
      database(),
      (await sessionToken()) ?? "",
      parsed.data.branchId,
    );
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
