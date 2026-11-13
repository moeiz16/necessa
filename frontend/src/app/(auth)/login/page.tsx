"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, KeyRound, ShieldCheck, TestTube2 } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useEffect, useRef, useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ApiError, errorMessage, isDemoForced, setDemoMode } from "@/lib/api/client";
import { useDemoMode, useSession } from "@/lib/api/session";
import { ROLE_LABEL } from "@/lib/format";
import { Button } from "@/components/ui/button";
import { Avatar } from "@/components/ui/display";
import { Field, Input } from "@/components/ui/input";

const schema = z.object({ email: z.string().email("Enter a valid email"), password: z.string().min(1, "Enter your password") });
type FormValues = z.infer<typeof schema>;

const DEMO_ACCOUNTS = [
  { email: "maya@riverbend.demo", name: "Maya Okafor", role: "admin", color: "#3e4bdb" },
  { email: "jordan@riverbend.demo", name: "Jordan Ellis", role: "coordinator", color: "#0f7a55" },
  { email: "praman@riverbend.demo", name: "Dr. Priya Raman", role: "clinician", color: "#8b5cf6" },
  { email: "tessa@riverbend.demo", name: "Tessa Morgan, RN", role: "reviewer", color: "#1fb5cc" },
  { email: "grace@riverbend.demo", name: "Grace Liu", role: "auditor", color: "#565b64", mfa: true },
] as const;

function LoginInner() {
  const router = useRouter();
  const params = useSearchParams();
  const next = params.get("next") || "/dashboard";
  const { login, status } = useSession();
  const demo = useDemoMode();
  const [mfa, setMfa] = useState<FormValues | null>(null);
  const [code, setCode] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const autoRan = useRef(false);

  const form = useForm<FormValues>({ resolver: zodResolver(schema), defaultValues: { email: "", password: "" } });

  const finish = () => router.replace(next.startsWith("/") ? next : "/dashboard");

  const submit = async (values: FormValues, mfaCode?: string) => {
    setBusy(true);
    setError(null);
    try {
      const res = await login({ ...values, mfaCode });
      if (res.mfaRequired) setMfa(values);
      else finish();
    } catch (e) {
      setError(e instanceof ApiError ? e.problem.detail || e.problem.title : errorMessage(e));
    } finally {
      setBusy(false);
    }
  };

  const enterDemo = async (email: string = DEMO_ACCOUNTS[0].email) => {
    setDemoMode(true);
    demo.toggle(true);
    await submit({ email, password: "demo" });
  };

  useEffect(() => {
    if (params.get("demo") === "1" && !autoRan.current) {
      autoRan.current = true;
      void enterDemo();
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [params]);

  useEffect(() => {
    if (status === "authenticated" && !params.get("demo")) finish();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status]);

  if (mfa) {
    return (
      <div className="animate-[rise_240ms]">
        <span className="flex size-10 items-center justify-center rounded-full bg-brand-soft text-brand">
          <ShieldCheck className="size-5" />
        </span>
        <h1 className="mt-5 text-2xl font-semibold tracking-tight text-fg">Two-step verification</h1>
        <p className="mt-1.5 text-sm text-muted">Enter the 6-digit code from your authenticator app.{demo.on ? " In the demo, use 123456." : ""}</p>
        <form
          className="mt-8 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(mfa, code);
          }}
        >
          <Field label="Verification code" htmlFor="otp" error={error}>
            <Input
              id="otp"
              inputMode="numeric"
              autoComplete="one-time-code"
              maxLength={6}
              value={code}
              onChange={(e) => setCode(e.target.value.replace(/\D/g, ""))}
              className="h-11 text-center font-mono text-lg tracking-[0.5em]"
              autoFocus
              aria-invalid={!!error}
            />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
            Verify and continue
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMfa(null)}>
            Use a different account
          </Button>
        </form>
      </div>
    );
  }

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-tight text-fg">Welcome back</h1>
      <p className="mt-1.5 text-sm text-muted">Sign in to your Necessa workspace.</p>

      <form className="mt-8 grid gap-4" onSubmit={form.handleSubmit((v) => submit(v))} noValidate>
        <Field label="Work email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" placeholder="you@practice.com" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
        </Field>
        <Field
          label={
            <span className="flex w-full items-center justify-between">
              Password
              <Link href="/forgot-password" className="text-xs font-normal text-brand hover:underline">
                Forgot password?
              </Link>
            </span>
          }
          htmlFor="password"
          error={form.formState.errors.password?.message}
        >
          <Input id="password" type="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
        </Field>
        {error ? (
          <div role="alert" className="rounded-md bg-notmet-soft px-3 py-2 text-[13px] text-notmet-fg">
            {error}
          </div>
        ) : null}
        <Button type="submit" variant="primary" size="lg" loading={busy}>
          Sign in
          <ArrowRight />
        </Button>
      </form>

      <div className="my-6 flex items-center gap-3 text-xs text-subtle">
        <span className="h-px flex-1 bg-border" />
        or
        <span className="h-px flex-1 bg-border" />
      </div>

      <Button type="button" variant="secondary" size="lg" className="w-full" onClick={() => enterDemo()} loading={busy && demo.on}>
        <TestTube2 />
        Explore the demo — no sign-up
      </Button>

      {demo.on ? (
        <div className="mt-6 rounded-xl border border-border bg-surface p-3">
          <p className="flex items-center gap-1.5 px-1 text-xs font-medium text-muted">
            <KeyRound className="size-3.5" /> Demo accounts — sign in as any role to explore RBAC
          </p>
          <ul className="mt-2 grid gap-0.5">
            {DEMO_ACCOUNTS.map((a) => (
              <li key={a.email}>
                <button
                  type="button"
                  onClick={() => enterDemo(a.email)}
                  className="flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2"
                >
                  <Avatar name={a.name} color={a.color} size={24} />
                  <span className="min-w-0 flex-1 truncate text-[13px] text-fg">{a.name}</span>
                  <span className="text-[11px] text-subtle">
                    {ROLE_LABEL[a.role]}
                    {"mfa" in a ? " · MFA" : ""}
                  </span>
                </button>
              </li>
            ))}
          </ul>
          {!isDemoForced() ? (
            <button type="button" className="mt-2 px-1 text-xs text-brand hover:underline" onClick={() => demo.toggle(false)}>
              Use the live API instead
            </button>
          ) : null}
        </div>
      ) : null}

      <p className="mt-8 text-center text-[13px] text-muted">
        New to Necessa?{" "}
        <Link href="/signup" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </p>
    </div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
