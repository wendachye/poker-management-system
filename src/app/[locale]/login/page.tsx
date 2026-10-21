"use client";
import { useState, type ComponentProps } from "react";
import { Eye, EyeOff } from "lucide-react";
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
import { Alert, AlertDescription } from "@/components/ui/alert";
import { FieldSet } from "@/components/ui/field";
import { useAuth } from "@/contexts/auth-context";
import { useRouter } from "@/i18n/navigation";
import {
  Field,
  useText,
} from "@/components/page/PokerManagementPage/components/shared";
import { LanguageSwitcher } from "@/components/layout/language-switcher";
import { prototypeEnabled } from "@/prototype/config";
import { PrototypeEntry } from "@/prototype/prototype-entry";
export default function LoginPage() {
  return prototypeEnabled ? <PrototypeEntry /> : <StaffLoginPage />;
}
function StaffLoginPage() {
  const { login, loading } = useAuth();
  const router = useRouter();
  const t = useText();
  const [username, setUsername] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState("");
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
              {t("Sign in with your staff account.")}
            </CardDescription>
          </CardHeader>
          <CardContent>
            <form
              className="space-y-5"
              onSubmit={async (event) => {
                event.preventDefault();
                setBusy(true);
                setError("");
                try {
                  await login(username, password);
                  router.replace("/dashboard");
                  router.refresh();
                } catch (error) {
                  setError(
                    error instanceof Error ? error.message : "Sign-in failed.",
                  );
                } finally {
                  setBusy(false);
                }
              }}
            >
              {error && (
                <Alert variant="destructive">
                  <AlertDescription>{t(error)}</AlertDescription>
                </Alert>
              )}
              <FieldSet disabled={loading || busy} className="gap-5">
                <Field label="Username">
                  <Input
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
                  className="w-full"
                  disabled={loading || busy}
                >
                  {t(busy ? "Signing in…" : "Sign in")}
                </Button>
              </FieldSet>
            </form>
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
    <InputGroup className="h-10">
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
