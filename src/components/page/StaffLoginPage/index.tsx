"use client";
import { useEffect, useRef, useState, type ComponentProps } from "react";
import { Eye, EyeOff, LoaderCircle } from "lucide-react";
import {
  InputGroup,
  InputGroupInput,
  InputGroupAddon,
  InputGroupButton,
} from "@/components/ui/input-group";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  Card,
  CardContent,
  CardHeader,
  CardTitle,
  CardDescription,
} from "@/components/ui/card";
import { Alert, AlertDescription, AlertTitle } from "@/components/ui/alert";
import { FieldSet } from "@/components/ui/field";
import { useAuth } from "@/contexts/auth-context";
import { useRouter } from "@/i18n/navigation";
import {
  Field,
  useText,
} from "@/components/page/PokerManagementPage/components/shared";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { ManagementResponseError } from "@/lib/management-response";
import { checkStaffSession } from "@/lib/session-recovery";
import {
  StaffAccountMismatchError,
  STAFF_ACCOUNT_MISMATCH_MESSAGE,
} from "@/lib/login-identity";

export function StaffLoginPage({
  unavailable = false,
}: {
  unavailable?: boolean;
}) {
  const auth = useAuth();
  const router = useRouter();
  const t = useText();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<"login" | "check" | null>(null);
  const [error, setError] = useState("");
  const [connectionUnavailable, setConnectionUnavailable] = useState(false);
  const [anotherAccount, setAnotherAccount] = useState(false);
  const [accountMismatch, setAccountMismatch] = useState(false);
  const [expectedUsername, setExpectedUsername] = useState<string>();
  const inFlight = useRef(false);
  const usernameInput = useRef<HTMLInputElement>(null);
  const serviceError =
    !accountMismatch &&
    (connectionUnavailable || !!auth.error || (unavailable && !!auth.user));
  const hasSession = !!auth.user && !anotherAccount;
  useEffect(() => {
    if (accountMismatch && busy === null) usernameInput.current?.focus();
  }, [accountMismatch, busy]);

  function enterSystem() {
    router.replace("/dashboard");
    router.refresh();
  }
  function showAccountMismatch() {
    setPassword("");
    setConnectionUnavailable(false);
    setAccountMismatch(true);
    setAnotherAccount(true);
    setError(STAFF_ACCOUNT_MISMATCH_MESSAGE);
  }
  async function checkConnection() {
    if (inFlight.current || auth.loading) return;
    inFlight.current = true;
    setBusy("check");
    setError("");
    setPassword("");
    try {
      const result = await checkStaffSession(auth.refresh, expectedUsername);
      if (result.status === "authenticated") {
        setConnectionUnavailable(false);
        enterSystem();
      } else if (result.status === "signed-out") {
        setConnectionUnavailable(false);
        setAccountMismatch(false);
        setAnotherAccount(false);
        requestAnimationFrame(() => usernameInput.current?.focus());
      } else if (result.status === "different-account") {
        showAccountMismatch();
      } else {
        setConnectionUnavailable(true);
        setError(result.message);
      }
    } finally {
      inFlight.current = false;
      setBusy(null);
    }
  }
  return (
    <main className="flex min-h-screen items-center justify-center p-4">
      <div className="w-full max-w-sm space-y-5">
        <div className="flex justify-end">
          <LanguageSwitcher />
        </div>
        <Card>
          <CardHeader>
            <CardTitle>
              <h1 className="text-2xl">{t("Poker Management")}</h1>
            </CardTitle>
            <CardDescription>
              {t(
                serviceError || hasSession
                  ? "Check your connection and continue."
                  : "Sign in with your staff account.",
              )}
            </CardDescription>
          </CardHeader>
          <CardContent>
            {auth.loading ? (
              <p
                role="status"
                className="flex items-center gap-2 text-sm text-muted-foreground"
              >
                <LoaderCircle
                  aria-hidden="true"
                  className="size-4 animate-spin"
                />
                {t("Checking staff access…")}
              </p>
            ) : serviceError || hasSession ? (
              <div className="space-y-4">
                <Alert role={serviceError ? "alert" : "status"}>
                  <AlertTitle>
                    {t(
                      serviceError
                        ? "Connection unavailable"
                        : "Continue your session",
                    )}
                  </AlertTitle>
                  <AlertDescription>
                    <p>
                      {t(
                        serviceError
                          ? "The service could not be reached. Check the connection to continue with your existing session."
                          : "A staff session is available. Check access to continue.",
                      )}
                    </p>
                    {error && <p>{t(error)}</p>}
                  </AlertDescription>
                </Alert>
                <Button
                  type="button"
                  className="min-h-11 w-full"
                  disabled={!!busy}
                  onClick={() => void checkConnection()}
                >
                  {busy === "check" && (
                    <LoaderCircle
                      aria-hidden="true"
                      className="size-4 animate-spin"
                    />
                  )}
                  {t(
                    busy === "check"
                      ? "Checking connection…"
                      : serviceError
                        ? "Retry connection"
                        : "Continue",
                  )}
                </Button>
                {!serviceError && (
                  <Button
                    type="button"
                    variant="outline"
                    className="min-h-11 w-full"
                    disabled={!!busy}
                    onClick={() => {
                      setAnotherAccount(true);
                      setError("");
                      setPassword("");
                      requestAnimationFrame(() =>
                        usernameInput.current?.focus(),
                      );
                    }}
                  >
                    {t("Use another account")}
                  </Button>
                )}
              </div>
            ) : (
              <form
                className="space-y-5"
                onSubmit={async (event) => {
                  event.preventDefault();
                  if (inFlight.current) return;
                  inFlight.current = true;
                  setBusy("login");
                  setError("");
                  setAccountMismatch(false);
                  setExpectedUsername(username);
                  try {
                    await auth.login(username, password);
                    enterSystem();
                  } catch (error) {
                    setError(
                      error instanceof Error
                        ? error.message
                        : "Sign-in failed.",
                    );
                    if (error instanceof StaffAccountMismatchError) {
                      showAccountMismatch();
                    } else if (
                      error instanceof ManagementResponseError &&
                      error.uncertain
                    ) {
                      setAccountMismatch(false);
                      setConnectionUnavailable(true);
                      setPassword("");
                    }
                  } finally {
                    inFlight.current = false;
                    setBusy(null);
                  }
                }}
              >
                {error && (
                  <Alert variant="destructive" role="alert">
                    <AlertDescription>{t(error)}</AlertDescription>
                  </Alert>
                )}
                <FieldSet disabled={!!busy} className="gap-5">
                  <Field label="Username">
                    <Input
                      ref={usernameInput}
                      required
                      autoComplete="username"
                      value={username}
                      onChange={(e) => setUsername(e.target.value)}
                      maxLength={100}
                    />
                  </Field>
                  <Field label="Password">
                    <PasswordInput
                      required
                      autoComplete="current-password"
                      value={password}
                      onChange={(e) => setPassword(e.target.value)}
                      maxLength={128}
                    />
                  </Field>
                  <Button
                    type="submit"
                    className="min-h-11 w-full"
                    disabled={!!busy}
                  >
                    {t(busy === "login" ? "Signing in…" : "Sign in")}
                  </Button>
                </FieldSet>
              </form>
            )}
            <p className="mt-4 text-center text-sm text-muted-foreground">
              {t("Need account access? Contact your venue administrator.")}
            </p>
          </CardContent>
        </Card>
      </div>
    </main>
  );
}

function PasswordInput(props: ComponentProps<typeof InputGroupInput>) {
  const t = useText();
  const [visible, setVisible] = useState(false);
  return (
    <InputGroup className="h-11">
      <InputGroupInput {...props} type={visible ? "text" : "password"} />
      <InputGroupAddon align="inline-end">
        <InputGroupButton
          type="button"
          aria-label={t(visible ? "Hide password" : "Show password")}
          aria-pressed={visible}
          onClick={() => setVisible((value) => !value)}
        >
          {visible ? <EyeOff /> : <Eye />}
        </InputGroupButton>
      </InputGroupAddon>
    </InputGroup>
  );
}
