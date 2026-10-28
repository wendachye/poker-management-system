import { cookies } from "next/headers";
import { z } from "zod";
import {
  branchesForUser,
  login,
  logout,
  requireUser,
  SESSION_COOKIE,
  SESSION_SECONDS,
} from "@/server/auth";
import { database } from "@/server/database";
import {
  body,
  failure,
  json,
  prototypeApiResponse,
  sessionToken,
} from "@/server/http";
import { DomainError } from "@/domain/operations";
import { authAdmissionRetryAfter } from "@/server/password-work";

export const runtime = "nodejs";
export async function GET() {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    const db = database();
    const user = await requireUser(db, await sessionToken());
    return json({ user, branches: await branchesForUser(db, user.id) });
  } catch (error) {
    return failure(error);
  }
}
export async function POST(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    const credentials = z
      .object({
        username: z.string().trim().min(1).max(100),
        password: z.string().min(1).max(128),
      })
      .strict()
      .safeParse(await body(request));
    if (!credentials.success)
      throw new DomainError("Enter your username and password.");
    const db = database();
    const token = await login(
      db,
      credentials.data.username,
      credentials.data.password,
    );
    await logout(db, await sessionToken());
    (await cookies()).set(SESSION_COOKIE, token, {
      httpOnly: true,
      secure: process.env.NODE_ENV === "production",
      sameSite: "strict",
      path: "/",
      maxAge: SESSION_SECONDS,
    });
    return json({ user: await requireUser(db, token) });
  } catch (error) {
    const retryAfter = authAdmissionRetryAfter(error);
    if (retryAfter !== null) {
      const response = json(
        { error: (error as Error).message },
        (error as DomainError).status,
      );
      response.headers.set("Retry-After", String(retryAfter));
      return response;
    }
    return failure(error);
  }
}
export async function DELETE(request: Request) {
  const disabled = prototypeApiResponse();
  if (disabled) return disabled;
  try {
    await body(request);
    await logout(database(), await sessionToken());
    (await cookies()).delete(SESSION_COOKIE);
    return json({ ok: true });
  } catch (error) {
    return failure(error);
  }
}
