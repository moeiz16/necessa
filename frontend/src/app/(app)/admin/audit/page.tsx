"use client";

import { Download, ShieldCheck, ShieldX } from "lucide-react";
import { useEffect, useMemo, useState } from "react";
import { useAudit, useMembers, useVerifyAudit } from "@/lib/api/hooks";
import type { AuditEntry } from "@/lib/api/types";
import { fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Avatar, Breadcrumb, Card, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Sheet, SheetContent } from "@/components/ui/overlays";
import { actionLabel, actorName, CATEGORIES, isInternalEvent, isSensitive, itemLabel, purposeOf } from "./labels";

export default function CompliancePage() {
  const [category, setCategory] = useState<string | null>(null);
  const [person, setPerson] = useState("all");
  const members = useMembers();
  const audit = useAudit({ actor: person === "all" ? undefined : person, limit: 200 });
  const verify = useVerifyAudit();
  const [open, setOpen] = useState<AuditEntry | null>(null);

  // Check the log's integrity once when the page opens, and again on request.
  const { mutate: runVerify } = verify;
  useEffect(() => {
    runVerify();
  }, [runVerify]);

  const all = useMemo(() => (audit.data?.items ?? []).filter((r) => !isInternalEvent(r.action)), [audit.data]);
  const rows = useMemo(() => {
    const cat = CATEGORIES.find((c) => c.id === category);
    return cat ? all.filter((r) => cat.test(r.action)) : all;
  }, [all, category]);
  const patientViews = all.filter((r) => /^phi\.|reveal/.test(r.action)).length;
  const team = members.data ?? [];
  const withTwoStep = team.filter((m) => m.mfaEnabled).length;

  const exportCsv = () => {
    const head = ["Time", "Person", "What happened", "Item", "Purpose"];
    const lines = rows.map((r) => [r.createdAt, actorName(r) ?? "Necessa", actionLabel(r.action), itemLabel(r.resourceType), purposeOf(r) ?? ""]);
    const csv = [head, ...lines].map((l) => l.map((v) => `"${String(v).replace(/"/g, '""')}"`).join(",")).join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `necessa-activity-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  const intact = verify.data?.valid;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Compliance" }]} />} wide>
      <PageHeader
        title="Compliance"
        description="Every sign-in, patient-record view and change is recorded and can't be edited. Use this log for access reviews and audits."
        actions={
          <Button variant="secondary" onClick={exportCsv} disabled={!rows.length}>
            <Download /> Export
          </Button>
        }
      />

      <div className="mb-6 grid gap-3 sm:grid-cols-3">
        <Card className="p-4">
          <p className="text-xs text-muted">Activity log</p>
          <p className="mt-1 flex items-center gap-2 text-[15px] font-medium text-fg">
            {verify.isPending ? (
              <span className="text-muted">Checking…</span>
            ) : intact === false ? (
              <>
                <ShieldX className="size-4 text-notmet" /> Needs attention
              </>
            ) : (
              <>
                <ShieldCheck className="size-4 text-met" /> Verified
              </>
            )}
          </p>
          <p className="mt-1 text-xs text-subtle">
            {verify.data
              ? intact
                ? `${fmtNumber(verify.data.checked)} entries checked, none altered`
                : "A change to the record was detected. Contact support."
              : "Confirms no entry has been changed or removed"}
          </p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">Patient details viewed</p>
          <p className="tabular mt-1 text-[22px] font-semibold tracking-tight text-fg">{fmtNumber(patientViews)}</p>
          <p className="mt-1 text-xs text-subtle">Details are masked by default; each view is logged with its purpose</p>
        </Card>
        <Card className="p-4">
          <p className="text-xs text-muted">Two-step verification</p>
          <p className="tabular mt-1 text-[22px] font-semibold tracking-tight text-fg">
            {team.length ? `${withTwoStep} of ${team.length}` : "–"}
            <span className="ml-1.5 text-sm font-normal text-muted">people</span>
          </p>
          <p className="mt-1 text-xs text-subtle">Turn it on for everyone in Team &amp; settings</p>
        </Card>
      </div>

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-4 py-3">
          <div className="flex flex-wrap gap-1.5" role="group" aria-label="Filter by type">
            <button
              onClick={() => setCategory(null)}
              aria-pressed={category === null}
              className={cn("h-7 rounded-full px-3 text-xs transition-colors", category === null ? "bg-fg text-bg" : "text-muted hover:text-fg")}
            >
              All activity
            </button>
            {CATEGORIES.map((c) => (
              <button
                key={c.id}
                onClick={() => setCategory(category === c.id ? null : c.id)}
                aria-pressed={category === c.id}
                className={cn("h-7 rounded-full px-3 text-xs transition-colors", category === c.id ? "bg-fg text-bg" : "text-muted hover:text-fg")}
              >
                {c.label}
              </button>
            ))}
          </div>
          <div className="w-full sm:ml-auto sm:w-52">
            <Select
              size="sm"
              value={person}
              onValueChange={setPerson}
              aria-label="Person"
              options={[{ value: "all", label: "Everyone" }, ...team.map((m) => ({ value: m.id, label: m.fullName }))]}
            />
          </div>
        </div>

        {audit.isPending ? (
          <Skeleton className="m-4 h-60" />
        ) : rows.length === 0 ? (
          <EmptyState compact art="shield" title="No activity to show" description="Try a different filter." />
        ) : (
          <ul className="divide-y divide-border">
            {rows.map((r) => {
              const who = actorName(r);
              const purpose = purposeOf(r);
              return (
                <li key={r.id}>
                  <button
                    onClick={() => setOpen(r)}
                    className="grid w-full grid-cols-[auto_1fr_auto] items-center gap-3 px-4 py-3 text-left outline-none transition-colors hover:bg-surface-2/60 focus-visible:bg-surface-2"
                  >
                    <Avatar name={who ?? "Necessa"} color={r.actor?.avatarColor ?? "var(--degraded)"} size={28} />
                    <span className="grid min-w-0 gap-0.5">
                      <span className="flex flex-wrap items-baseline gap-x-2 text-[13.5px]">
                        <span className="font-medium text-fg">{who ?? "Necessa"}</span>
                        <span className={cn("text-fg", isSensitive(r.action) && "font-medium")}>{actionLabel(r.action).toLowerCase()}</span>
                        {isSensitive(r.action) ? <span className="text-xs text-insufficient-fg">· sensitive</span> : null}
                      </span>
                      <span className="truncate text-xs text-muted">
                        {itemLabel(r.resourceType)}
                        {purpose ? ` · Purpose: ${purpose}` : ""}
                      </span>
                    </span>
                    <span className="whitespace-nowrap text-xs text-subtle" title={fmtDateTime(r.createdAt)}>
                      {fmtRelative(r.createdAt)}
                    </span>
                  </button>
                </li>
              );
            })}
          </ul>
        )}
        {audit.data && (audit.data.total ?? 0) > all.length ? (
          <p className="border-t border-border px-4 py-2.5 text-xs text-subtle">
            Showing the latest {fmtNumber(all.length)} of {fmtNumber(audit.data.total ?? 0)} entries. Export includes what is shown.
          </p>
        ) : null}
      </Card>

      <Sheet open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        {open ? (
          <SheetContent title={actionLabel(open.action)} description={fmtDateTime(open.createdAt)}>
            <dl className="grid gap-4 p-5 text-[13px]">
              <div className="grid gap-1">
                <dt className="text-xs text-muted">Person</dt>
                <dd className="text-fg">{actorName(open) ?? "Necessa (automatic)"}</dd>
              </div>
              <div className="grid gap-1">
                <dt className="text-xs text-muted">Item</dt>
                <dd className="text-fg">{itemLabel(open.resourceType)}</dd>
              </div>
              {purposeOf(open) ? (
                <div className="grid gap-1">
                  <dt className="text-xs text-muted">Purpose given</dt>
                  <dd className="text-fg">{purposeOf(open)}</dd>
                </div>
              ) : null}
              {open.ip ? (
                <div className="grid gap-1">
                  <dt className="text-xs text-muted">From</dt>
                  <dd className="text-fg">{open.ip}</dd>
                </div>
              ) : null}
              <p className="rounded-lg bg-surface-2 px-3 py-2 text-xs leading-relaxed text-muted">This entry is part of a permanent record and can&apos;t be edited or removed.</p>
            </dl>
          </SheetContent>
        ) : null}
      </Sheet>
    </AppPage>
  );
}
