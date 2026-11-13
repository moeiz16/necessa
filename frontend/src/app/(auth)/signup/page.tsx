"use client";

import { zodResolver } from "@hookform/resolvers/zod";
import { useQueryClient } from "@tanstack/react-query";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { useState } from "react";
import { useForm } from "react-hook-form";
import { z } from "zod";
import { ApiError, api, errorMessage } from "@/lib/api/client";
import { qk } from "@/lib/api/hooks";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/controls";
import { Field, Input, PasswordInput } from "@/components/ui/input";
import { StrengthMeter } from "@/components/domain/password-strength";

const schema = z.object({
  fullName: z.string().min(2, "Enter your full name"),
  email: z.string().email("Enter a valid work email"),
  password: z.string().min(12, "Use at least 12 characters"),
  terms: z.literal(true, { errorMap: () => ({ message: "Please accept to continue" }) }),
});
type V = z.infer<typeof schema>;

export default function SignupPage() {
  const router = useRouter();
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const form = useForm<V>({ resolver: zodResolver(schema), defaultValues: { fullName: "", email: "", password: "", terms: false as unknown as true } });
  const pw = form.watch("password");

  const onSubmit = async (v: V) => {
    setError(null);
    try {
      await api.post("/auth/signup", { fullName: v.fullName, email: v.email, password: v.password });
      await qc.invalidateQueries({ queryKey: qk.me });
      router.push("/onboarding");
    } catch (e) {
      if (e instanceof ApiError && e.problem.errors?.length) {
        for (const [field, msg] of Object.entries(e.fieldErrors)) form.setError(field as keyof V, { message: msg });
      } else setError(errorMessage(e));
    }
  };

  return (
    <div>
      <h1 className="text-2xl font-semibold tracking-[-0.02em] text-fg">Create your workspace</h1>
      <p className="mt-1.5 text-sm text-muted">Set up your practice in about two minutes.</p>
      <form method="post" className="mt-8 grid gap-4" onSubmit={form.handleSubmit(onSubmit)} noValidate>
        <Field label="Full name" htmlFor="fullName" error={form.formState.errors.fullName?.message}>
          <Input id="fullName" autoComplete="name" {...form.register("fullName")} aria-invalid={!!form.formState.errors.fullName} />
        </Field>
        <Field label="Work email" htmlFor="email" error={form.formState.errors.email?.message}>
          <Input id="email" type="email" autoComplete="email" {...form.register("email")} aria-invalid={!!form.formState.errors.email} />
        </Field>
        <Field label="Password" htmlFor="password" error={form.formState.errors.password?.message}>
          <PasswordInput id="password" autoComplete="new-password" {...form.register("password")} aria-invalid={!!form.formState.errors.password} />
          <StrengthMeter value={pw} />
        </Field>
        <label className="flex items-start gap-2.5 text-[13px] text-muted">
          <Checkbox className="mt-0.5" checked={!!form.watch("terms")} onCheckedChange={(c) => form.setValue("terms", (c === true) as true, { shouldValidate: true })} />
          <span>
            I understand Necessa supports documentation review and doesn&apos;t make coverage decisions, and that real patient information may only be added under a signed business associate agreement (BAA).
          </span>
        </label>
        {form.formState.errors.terms ? <p className="-mt-2 text-xs text-notmet-fg">{form.formState.errors.terms.message}</p> : null}
        {error ? <div role="alert" className="rounded-md bg-notmet-soft px-3 py-2 text-[13px] text-notmet-fg">{error}</div> : null}
        <Button type="submit" variant="primary" size="lg" loading={form.formState.isSubmitting}>
          Create account
        </Button>
      </form>
      <p className="mt-8 text-center text-[13px] text-muted">
        Already have an account?{" "}
        <Link href="/login" className="font-medium text-brand hover:underline">
          Sign in
        </Link>
      </p>
    </div>
  );
}
