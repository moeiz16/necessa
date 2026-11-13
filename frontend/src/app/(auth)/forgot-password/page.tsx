"use client";

import { MailCheck } from "lucide-react";
import Link from "next/link";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { Button } from "@/components/ui/button";
import { Field, Input } from "@/components/ui/input";

export default function ForgotPasswordPage() {
  const [email, setEmail] = useState("");
  const [sent, setSent] = useState<{ devLink?: string } | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (sent) {
    return (
      <div className="animate-[rise_240ms]">
        <span className="flex size-10 items-center justify-center rounded-full bg-met-soft text-met">
          <MailCheck className="size-5" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight">Check your inbox</h1>
        <p className="mt-1.5 text-sm text-muted">If an account exists for {email}, a reset link is on its way. The link expires in 30 minutes.</p>
        {sent.devLink ? (
          <div className="mt-6 rounded-lg border border-dashed border-border-strong p-3 text-[13px]">
            <p className="text-xs text-subtle">Development mode — email delivery is simulated</p>
            <Link href={sent.devLink} className="mt-1 block font-medium text-brand hover:underline">
              Open reset link
            </Link>
          </div>
        ) : null}
        <Button asChild variant="ghost" className="mt-6">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight">Reset your password</h1>
      <p className="mt-1.5 text-sm text-muted">We&apos;ll email you a secure link to choose a new one.</p>
      <form
        className="mt-8 grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            setSent(await api.post<{ devLink?: string }>("/auth/password/forgot", { email }));
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Work email" htmlFor="email" error={error}>
          <Input id="email" type="email" required value={email} onChange={(e) => setEmail(e.target.value)} autoComplete="email" />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!email}>
          Send reset link
        </Button>
        <Button asChild variant="ghost">
          <Link href="/login">Back to sign in</Link>
        </Button>
      </form>
    </div>
  );
}
