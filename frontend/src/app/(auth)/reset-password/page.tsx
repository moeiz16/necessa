"use client";

import { CircleCheck } from "lucide-react";
import Link from "next/link";
import { useSearchParams } from "next/navigation";
import { Suspense, useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Field, PasswordInput } from "@/components/ui/input";
import { StrengthMeter } from "@/components/domain/password-strength";

function ResetInner() {
  const token = useSearchParams().get("token") ?? "";
  const [pw, setPw] = useState("");
  const [confirm, setConfirm] = useState("");
  const [done, setDone] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const mismatch = confirm.length > 0 && pw !== confirm;

  if (!token) {
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Link invalid or expired</h1>
        <p className="mt-1.5 text-sm text-muted">Request a fresh reset link to continue.</p>
        <Button asChild variant="primary" className="mt-6">
          <Link href="/forgot-password">Request a new link</Link>
        </Button>
      </div>
    );
  }
  if (done) {
    return (
      <div className="animate-[rise_240ms]">
        <CircleCheck className="size-8 text-met" />
        <h1 className="mt-4 text-2xl font-semibold tracking-tight">Password updated</h1>
        <p className="mt-1.5 text-sm text-muted">All other sessions were signed out for your security.</p>
        <Button asChild variant="primary" className="mt-6">
          <Link href="/login">Sign in</Link>
        </Button>
      </div>
    );
  }
  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Choose a new password</h1>
      <form
        method="post"
        className="mt-8 grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          if (mismatch) return;
          setBusy(true);
          setError(null);
          try {
            await api.post("/auth/password/reset", { token, password: pw });
            setDone(true);
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="New password" htmlFor="pw">
          <PasswordInput id="pw" autoComplete="new-password" value={pw} onChange={(e) => setPw(e.target.value)} />
          <StrengthMeter value={pw} />
        </Field>
        <Field label="Confirm password" htmlFor="confirm" error={mismatch ? "Passwords don’t match" : error}>
          <PasswordInput id="confirm" autoComplete="new-password" value={confirm} onChange={(e) => setConfirm(e.target.value)} aria-invalid={mismatch} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={pw.length < 12 || mismatch}>
          Update password
        </Button>
      </form>
    </div>
  );
}

export default function ResetPasswordPage() {
  return (
    <Suspense>
      <ResetInner />
    </Suspense>
  );
}
