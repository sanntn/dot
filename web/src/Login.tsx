import { useEffect, useState, type FormEvent, type ReactNode } from "react";
import { Alert, AlertDescription } from "@/components/ui/alert";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";
import { api, errorMessage, onSignedOut } from "./api.ts";

// Shows the board once Dot says this browser may use it. A Dot without DOT_PASSWORD passes straight through.
export function LoginGate({ children }: { children: ReactNode }) {
  const [state, setState] = useState<"loading" | "locked" | "open">("loading");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    const check = () =>
      api.session().then(
        (s) => setState(s.authRequired && !s.signedIn ? "locked" : "open"),
        (err) => {
          setError(errorMessage(err));
          setState("locked");
        },
      );
    void check();
    // Any API call that comes back 401 (an expired cookie, say) sends you back to the form.
    return onSignedOut(() => setState("locked"));
  }, []);

  async function onSubmit(e: FormEvent<HTMLFormElement>) {
    e.preventDefault();
    const password = String(new FormData(e.currentTarget).get("password") ?? "");
    setBusy(true);
    setError(null);
    try {
      await api.login(password);
      setState("open");
    } catch (err) {
      setError(errorMessage(err));
    } finally {
      setBusy(false);
    }
  }

  if (state === "open") return <>{children}</>;
  if (state === "loading") return null;

  return (
    <main className="grid min-h-dvh place-items-center p-4">
      <form className="grid w-full max-w-sm gap-4" onSubmit={(e) => void onSubmit(e)}>
        <h1 className="text-xl font-semibold">Dot</h1>
        <div className="grid gap-2">
          <Label htmlFor="dot-password">Password</Label>
          <Input id="dot-password" name="password" type="password" autoComplete="current-password" autoFocus required />
        </div>
        {error && (
          <Alert variant="destructive">
            <AlertDescription>{error}</AlertDescription>
          </Alert>
        )}
        <Button type="submit" disabled={busy} loading={busy}>
          Sign in
        </Button>
      </form>
    </main>
  );
}
