"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { MailOpen } from "lucide-react";
import Link from "next/link";
import { useParams, useRouter } from "next/navigation";
import { useState } from "react";
import { api, errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/hooks";
import { fmtDate, ROLE_LABEL } from "@/lib/format";
import type { Role } from "@/lib/api/types";
import { Button } from "@/components/ui/button";
import { Badge, Skeleton } from "@/components/ui/display";
import { Field, Input, PasswordInput } from "@/components/ui/input";

export default function InvitePage() {
  const { token } = useParams<{ token: string }>();
  const router = useRouter();
  const qc = useQueryClient();
  const inv = useQuery({
    queryKey: ["invitation", token],
    queryFn: () => api.get<{ orgName: string; email: string; role: Role; expiresAt: string }>(`/invitations/${token}`),
    retry: false,
  });
  const [fullName, setFullName] = useState("");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  if (inv.isPending) return <Skeleton className="h-64 w-full rounded-xl" />;
  if (inv.isError)
    return (
      <div>
        <h1 className="text-2xl font-semibold tracking-tight">Invitation unavailable</h1>
        <p className="mt-1.5 text-sm text-muted">{errorMessage(inv.error)} Ask your administrator to send a new one.</p>
        <Button asChild variant="secondary" className="mt-6">
          <Link href="/login">Go to sign in</Link>
        </Button>
      </div>
    );

  const d = inv.data;
  return (
    <div>
      <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand">
        <MailOpen className="size-5" />
      </span>
      <h1 className="mt-5 text-2xl font-semibold tracking-tight">Join {d.orgName}</h1>
      <p className="mt-1.5 text-sm text-muted">
        You&apos;ve been invited as <Badge tone="brand">{ROLE_LABEL[d.role]}</Badge> · {d.email} · expires {fmtDate(d.expiresAt)}
      </p>
      <form
        className="mt-8 grid gap-4"
        onSubmit={async (e) => {
          e.preventDefault();
          setBusy(true);
          setError(null);
          try {
            await api.post(`/invitations/${token}/accept`, { fullName, password });
            await qc.invalidateQueries({ queryKey: qk.me });
            router.push("/dashboard");
          } catch (err) {
            setError(errorMessage(err));
          } finally {
            setBusy(false);
          }
        }}
      >
        <Field label="Full name" htmlFor="name">
          <Input id="name" value={fullName} onChange={(e) => setFullName(e.target.value)} required />
        </Field>
        <Field label="Create a password" htmlFor="pw" hint="12+ characters" error={error}>
          <PasswordInput id="pw" value={password} onChange={(e) => setPassword(e.target.value)} required minLength={12} />
        </Field>
        <Button type="submit" variant="primary" size="lg" loading={busy} disabled={!fullName || password.length < 12}>
          Accept invitation
        </Button>
      </form>
    </div>
  );
}
