"use client";

/**
 * Case workspace chrome: the compact sticky header shown once the full header scrolls away, and the
 * purpose-of-use PHI reveal flow (minimum necessary: a stated reason, audited, auto re-masks).
 */
import { Eye, LockKeyhole, Play, ShieldCheck, Timer } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { useCallback, useEffect, useRef, useState } from "react";
import { cn } from "@/lib/utils";
import { ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { RadioCards } from "@/components/ui/controls";
import { Field, Textarea } from "@/components/ui/input";
import { Dialog, DialogContent, DialogFooter } from "@/components/ui/overlays";
import type { CaseStatus, Readiness } from "@/lib/api/types";

/** True once `ref` has scrolled under the 56px top bar. */
export function useScrolledPast<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  const [past, setPast] = useState(false);
  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const io = new IntersectionObserver(([e]) => setPast(!e!.isIntersecting && e!.boundingClientRect.top < 0), { rootMargin: "-56px 0px 0px 0px", threshold: 0 });
    io.observe(el);
    return () => io.disconnect();
  }, []);
  return { ref, past };
}

export function CompactCaseBar({
  show,
  number,
  title,
  status,
  readiness,
  score,
  dueAt,
  running,
  onEvaluate,
  canEvaluate,
}: {
  show: boolean;
  number: string;
  title: string;
  status: CaseStatus | "evaluating";
  readiness: Readiness;
  score?: number | null;
  dueAt?: string | null;
  running: boolean;
  onEvaluate: () => void;
  canEvaluate: boolean;
}) {
  const reduce = useReducedMotion();
  return (
    <div className="sticky top-14 z-20 h-0" aria-hidden={!show}>
      <AnimatePresence>
        {show ? (
          <motion.div
            initial={reduce ? false : { opacity: 0, y: -8 }}
            animate={{ opacity: 1, y: 0 }}
            exit={reduce ? { opacity: 0 } : { opacity: 0, y: -8 }}
            transition={{ duration: 0.18, ease: [0.22, 1, 0.36, 1] }}
            className="-mx-4 flex items-center gap-3 border-b border-border bg-bg px-4 py-2 sm:-mx-6 sm:px-6 lg:-mx-8 lg:px-8"
          >
            <ReadinessRing size={28} stroke={3} readiness={readiness} score={score} />
            <span className="hidden font-mono text-xs text-subtle sm:inline">{number}</span>
            <span className="min-w-0 flex-1 truncate text-[13px] font-semibold text-fg">{title}</span>
            <span className="hidden md:inline-flex">
              <StatusChip status={status as CaseStatus} />
            </span>
            {dueAt ? <SlaTimer dueAt={dueAt} compact className="hidden sm:inline-flex" /> : null}
            {canEvaluate ? (
              <Button size="sm" variant="primary" onClick={onEvaluate} loading={running}>
                {!running ? <Play /> : null}
                {running ? "Checking…" : "Check again"}
              </Button>
            ) : null}
          </motion.div>
        ) : null}
      </AnimatePresence>
    </div>
  );
}

const PURPOSES = [
  { value: "submission", label: "Payer submission", description: "Completing the prior-auth request" },
  { value: "appeal", label: "Appeal preparation", description: "Redetermination or reconsideration" },
  { value: "care", label: "Care coordination", description: "Scheduling or clinical follow-up" },
  { value: "other", label: "Other", description: "Describe below" },
] as const;

export const REVEAL_SECONDS = 300;

/**
 * Reveal flow: ask why, call `reveal(reason)` (which hits the API with reveal=true — audited server-side),
 * then auto re-mask after REVEAL_SECONDS. Returns state + controls for the case details card.
 */
export function usePhiReveal<T>(reveal: (reason: string) => Promise<T | null>) {
  const [open, setOpen] = useState(false);
  const [value, setValue] = useState<T | null>(null);
  const [until, setUntil] = useState<number | null>(null);
  const [now, setNow] = useState(() => Date.now());

  useEffect(() => {
    if (!until) return;
    const t = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) {
        setValue(null);
        setUntil(null);
      }
    }, 1000);
    return () => clearInterval(t);
  }, [until]);

  const confirm = useCallback(
    async (reason: string) => {
      const v = await reveal(reason);
      if (v) {
        setValue(v);
        setUntil(Date.now() + REVEAL_SECONDS * 1000);
        setNow(Date.now());
      }
      return !!v;
    },
    [reveal],
  );
  const hide = useCallback(() => {
    setValue(null);
    setUntil(null);
  }, []);
  const remaining = until ? Math.max(0, Math.round((until - now) / 1000)) : 0;
  return { open, setOpen, value, confirm, hide, remaining };
}

export function RevealDialog({ open, onOpenChange, onConfirm }: { open: boolean; onOpenChange: (v: boolean) => void; onConfirm: (reason: string) => Promise<boolean> }) {
  const [purpose, setPurpose] = useState<string>("submission");
  const [note, setNote] = useState("");
  const [busy, setBusy] = useState(false);
  const reason = purpose === "other" ? note.trim() : `${PURPOSES.find((p) => p.value === purpose)?.label}${note.trim() ? ` — ${note.trim()}` : ""}`;
  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent title="Show protected patient details" description="Open only what you need for the task at hand. This access is recorded in the audit trail with your stated purpose." size="sm">
        <div className="grid gap-4">
          <Field label="Purpose of use">
            <RadioCards value={purpose} onValueChange={setPurpose} columns={2} options={PURPOSES.map((p) => ({ value: p.value, label: p.label, description: p.description }))} />
          </Field>
          <Field label={purpose === "other" ? "Reason" : "Note"} optional={purpose !== "other"}>
            <Textarea value={note} onChange={(e) => setNote(e.target.value)} className="min-h-16" placeholder={purpose === "other" ? "Why do you need the patient details?" : "e.g. Payer portal requires the MBI"} />
          </Field>
          <p className="flex items-start gap-2 text-xs leading-relaxed text-subtle">
            <Timer className="mt-px size-3.5 shrink-0" />
            Patient details are hidden again automatically after {REVEAL_SECONDS / 60} minutes or when you leave this case.
          </p>
        </div>
        <DialogFooter>
          <Button variant="ghost" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            variant="primary"
            loading={busy}
            disabled={reason.length < 4}
            onClick={async () => {
              setBusy(true);
              try {
                if (await onConfirm(reason)) onOpenChange(false);
              } finally {
                setBusy(false);
              }
            }}
          >
            <Eye /> Show and record access
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}

export function RevealState({ remaining, onHide, onReveal, visible, canReveal }: { remaining: number; onHide: () => void; onReveal: () => void; visible: boolean; canReveal: boolean }) {
  if (visible)
    return (
      <span className="flex items-center gap-1.5">
        <span className="tabular inline-flex items-center gap-1 rounded-md bg-insufficient-soft px-1.5 py-0.5 text-[11px] font-medium text-insufficient-fg" title="Patient details are hidden again automatically">
          <Eye className="size-3" /> {Math.floor(remaining / 60)}:{String(remaining % 60).padStart(2, "0")}
        </span>
        <Button size="xs" variant="ghost" onClick={onHide}>
          <LockKeyhole /> Mask
        </Button>
      </span>
    );
  return canReveal ? (
    <Button size="xs" variant="ghost" onClick={onReveal}>
      <ShieldCheck /> Show details
    </Button>
  ) : (
    <span className={cn("inline-flex items-center gap-1 text-[11px] text-subtle")}>
      <LockKeyhole className="size-3" /> Protected
    </span>
  );
}
