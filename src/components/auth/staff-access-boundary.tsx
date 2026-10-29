"use client";

import type { ReactNode } from "react";
import { LoaderCircle } from "lucide-react";
import { useAuth } from "@/contexts/auth-context";
import { prototypeEnabled } from "@/prototype/config";
import { Button } from "@/components/ui/button";
import { Alert, AlertDescription } from "@/components/ui/alert";
import {
  Card,
  CardContent,
  CardDescription,
  CardHeader,
  CardTitle,
} from "@/components/ui/card";
import { useText } from "@/components/page/PokerManagementPage/components/shared";

function SignOutRecovery() {
  const auth = useAuth();
  const t = useText();
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <Card className="w-full max-w-sm">
        <CardHeader>
          <CardTitle>
            <h1 className="text-2xl">{t("Finish signing out")}</h1>
          </CardTitle>
          <CardDescription>{t("Staff records are hidden.")}</CardDescription>
        </CardHeader>
        <CardContent className="space-y-4">
          <p role="status" className="text-sm text-muted-foreground">
            {t(
              auth.signOutBusy
                ? "Waiting for sign-out confirmation…"
                : "Sign-out is not confirmed. Retry sign out before continuing.",
            )}
          </p>
          <p className="text-sm text-muted-foreground">
            {t("This signs out the active session in this browser.")}
          </p>
          {auth.signOutError && (
            <Alert variant="destructive" role="alert">
              <AlertDescription>{t(auth.signOutError)}</AlertDescription>
            </Alert>
          )}
          <Button
            type="button"
            className="min-h-11 w-full"
            disabled={auth.signOutBusy}
            aria-busy={auth.signOutBusy}
            onClick={() => void auth.logout().catch(() => {})}
          >
            {auth.signOutBusy && (
              <LoaderCircle
                aria-hidden="true"
                className="size-4 animate-spin"
              />
            )}
            {t("Retry sign out")}
          </Button>
        </CardContent>
      </Card>
    </main>
  );
}

export function StaffAccessBoundary({ children }: { children: ReactNode }) {
  const auth = useAuth();
  const t = useText();
  if (prototypeEnabled) return children;
  if (auth.signingOut) return <SignOutRecovery />;
  if (auth.loading)
    return (
      <main className="flex min-h-screen items-center justify-center p-4">
        <p
          role="status"
          className="flex items-center gap-2 text-sm text-muted-foreground"
        >
          <LoaderCircle aria-hidden="true" className="size-4 animate-spin" />
          {t("Checking staff access…")}
        </p>
      </main>
    );
  return children;
}
