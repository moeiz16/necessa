"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { ArrowRight, ChevronDown, CirclePlay, KeyRound, ShieldCheck } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
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
import { Field, Input, OtpInput, PasswordInput } from "@/components/ui/input";

const schema = z.object({ email: z.string().email("Enter a valid email"), password: z.string().min(1, "Enter your password") });
type FormValues = z.infer<typeof schema>;

/** Sample accounts. The first five match the API's seeded demo org (`necessa cases seed demo`), so they
 *  work in both the in-browser demo and against a real backend; the last one is browser-demo only. */
const DEMO_PASSWORD = "Demo!Pass2026";
const DEMO_ACCOUNTS: { email: string; name: string; role: string; color: string; mfa?: boolean; demoOnly?: boolean }[] = [
  { email: "maya.okafor@riverbend.demo", name: "Dr. Maya Okafor", role: "owner", color: "#0f766e" },
  { email: "jordan.reyes@riverbend.demo", name: "Jordan Reyes", role: "coordinator", color: "#7c3aed" },
  { email: "sam.whitfield@riverbend.demo", name: "Dr. Sam Whitfield", role: "clinician", color: "#2563eb" },
  { email: "priya.natarajan@riverbend.demo", name: "Priya Natarajan, RN", role: "reviewer", color: "#db2777" },
  { email: "leo.martins@riverbend.demo", name: "Leo Martins", role: "rcm_manager", color: "#ea580c" },
  { email: "grace@riverbend.demo", name: "Grace Liu", role: "auditor", color: "#565b64", mfa: true, demoOnly: true },
];

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
  const [showAccounts, setShowAccounts] = useState(false);
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

  const enterDemo = async (email: string = DEMO_ACCOUNTS[0]!.email) => {
    setDemoMode(true);
    demo.toggle(true);
    await submit({ email, password: DEMO_PASSWORD });
  };

  /** Sign in as a sample account in whichever mode is active (browser demo or the seeded API). */
  const signInAs = async (email: string, demoOnly?: boolean) => {
    if (demo.on || demoOnly) return enterDemo(email);
    form.setValue("email", email);
    form.setValue("password", DEMO_PASSWORD);
    await submit({ email, password: DEMO_PASSWORD });
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
      <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
        <ShieldCheck className="size-6 text-muted" />
        <h1 className="mt-5 text-2xl font-semibold tracking-[-0.02em] text-fg">Two-step verification</h1>
        <p className="mt-1.5 text-sm text-muted">
          Enter the 6-digit code from your authenticator app for <span className="font-medium text-fg">{mfa.email}</span>.{demo.on ? " In the sample workspace, use 123456." : ""}
        </p>
        <form
          method="post"
          className="mt-8 grid gap-4"
          onSubmit={(e) => {
            e.preventDefault();
            void submit(mfa, code);
          }}
        >
          <Field label="Verification code" error={error}>
            <OtpInput value={code} onChange={setCode} autoFocus invalid={!!error} onComplete={(v) => void submit(mfa, v)} />
          </Field>
          <Button type="submit" variant="primary" size="lg" loading={busy} disabled={code.length !== 6}>
            Verify and continue
          </Button>
          <Button type="button" variant="ghost" onClick={() => setMfa(null)}>
            Use a different account
          </Button>
        </form>
      </motion.div>
    );
  }

  return (
    <motion.div initial={{ opacity: 0 }} animate={{ opacity: 1 }} transition={{ duration: 0.18 }}>
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg">Welcome back</h1>
      <p className="mt-1.5 text-sm text-muted">Sign in to your Necessa workspace.</p>

      <form method="post" className="mt-8 grid gap-4" onSubmit={form.handleSubmit((v) => submit(v))} noValidate>
        <Field label="Work email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" placeholder="you@practice.com" aria-invalid={!!form.formState.errors.email} {...form.register("email")} />
        </Field>
        <Field
          label="Password"
          action={
            <Link href="/forgot-password" className="text-xs font-medium text-brand hover:underline">
              Forgot password?
            </Link>
          }
          htmlFor="password"
          error={form.formState.errors.password?.message}
        >
          <PasswordInput id="password" autoComplete="current-password" aria-invalid={!!form.formState.errors.password} {...form.register("password")} />
        </Field>
        <AnimatePresence>
          {error ? (
            <motion.div
              role="alert"
              initial={{ opacity: 0, height: 0 }}
              animate={{ opacity: 1, height: "auto" }}
              exit={{ opacity: 0, height: 0 }}
              className="overflow-hidden rounded-md bg-notmet-soft px-3 py-2 text-[13px] text-notmet-fg"
            >
              {error}
            </motion.div>
          ) : null}
        </AnimatePresence>
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
        <CirclePlay />
        Explore the demo
      </Button>

      <div className="mt-4 rounded-lg border border-border bg-surface">
        <button
          type="button"
          onClick={() => setShowAccounts((v) => !v)}
          aria-expanded={showAccounts || demo.on}
          className="flex w-full items-center gap-2 px-3 py-2.5 text-left text-xs font-medium text-muted outline-none hover:text-fg focus-visible:ring-2 focus-visible:ring-brand/30"
        >
          <KeyRound className="size-3.5" />
          <span className="flex-1">Sample accounts: try each role</span>
          <ChevronDown className={`size-3.5 transition-transform duration-150 ${showAccounts || demo.on ? "rotate-180" : ""}`} />
        </button>
        <AnimatePresence initial={false}>
          {showAccounts || demo.on ? (
            <motion.div initial={{ height: 0, opacity: 0 }} animate={{ height: "auto", opacity: 1 }} exit={{ height: 0, opacity: 0 }} transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }} className="overflow-hidden">
              <ul className="grid gap-0.5 border-t border-border p-1.5">
                {DEMO_ACCOUNTS.map((a) => (
                  <li key={a.email}>
                    <button
                      type="button"
                      disabled={busy}
                      onClick={() => signInAs(a.email, a.demoOnly)}
                      className="group flex w-full items-center gap-2.5 rounded-md px-2 py-1.5 text-left transition-colors hover:bg-surface-2 disabled:opacity-60"
                    >
                      <Avatar name={a.name} color={a.color} size={24} />
                      <span className="grid min-w-0 flex-1 leading-tight">
                        <span className="truncate text-[13px] text-fg">{a.name}</span>
                        <span className="truncate font-mono text-[10.5px] text-subtle">{a.email}</span>
                      </span>
                      <span className="text-right text-[11px] text-subtle">
                        {ROLE_LABEL[a.role]}
                        {a.mfa ? " · 2-step" : ""}
                        {a.demoOnly ? <span className="block text-[10px]">sample only</span> : null}
                      </span>
                    </button>
                  </li>
                ))}
              </ul>
              <p className="border-t border-border px-3 py-2 text-[11px] leading-relaxed text-subtle">
                {demo.on ? (
                  <>
                    You&apos;re exploring with sample data.{" "}
                    {!isDemoForced() ? (
                      <button type="button" className="text-brand hover:underline" onClick={() => demo.toggle(false)}>
                        Sign in with a real account instead
                      </button>
                    ) : null}
                  </>
                ) : (
                  <>
                    These sample accounts work when the sample workspace is loaded. Password: <span className="font-mono">{DEMO_PASSWORD}</span>.
                  </>
                )}
              </p>
            </motion.div>
          ) : null}
        </AnimatePresence>
      </div>

      <p className="mt-8 text-center text-[13px] text-muted">
        New to Necessa?{" "}
        <Link href="/signup" className="font-medium text-brand hover:underline">
          Create an account
        </Link>
      </p>
    </motion.div>
  );
}

export default function LoginPage() {
  return (
    <Suspense>
      <LoginInner />
    </Suspense>
  );
}
