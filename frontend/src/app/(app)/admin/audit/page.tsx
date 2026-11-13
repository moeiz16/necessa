"use client";

import { Download, Fingerprint, Link2, Search, ShieldCheck, ShieldX } from "lucide-react";
import { useMemo, useState } from "react";
import { useAudit, useMembers, useVerifyAudit } from "@/lib/api/hooks";
import type { AuditEntry } from "@/lib/api/types";
import { fmtDateTime, fmtNumber, fmtRelative } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { Avatar, Badge, Breadcrumb, Card, CardBody, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Sheet, SheetContent } from "@/components/ui/overlays";

const RESOURCE_TYPES = ["case", "case_document", "letter", "patient", "session", "organization", "membership", "invitation", "api_key", "criteria_set", "index_version", "denial", "llm_call", "audit_log"];

export default function AuditPage() {
  const [action, setAction] = useState("");
  const [rt, setRt] = useState("all");
  const [actor, setActor] = useState("all");
  const members = useMembers();
  const audit = useAudit({ action: action || undefined, resourceType: rt === "all" ? undefined : rt, actor: actor === "all" ? undefined : actor });
  const verify = useVerifyAudit();
  const [open, setOpen] = useState<AuditEntry | null>(null);
  const rows = useMemo(() => audit.data?.items ?? [], [audit.data]);

  const exportCsv = () => {
    const head = ["id", "created_at", "actor", "action", "resource_type", "resource_id", "ip", "hash", "prev_hash"];
    const csv = [head.join(","), ...rows.map((r) => [r.id, r.createdAt, r.actor?.fullName ?? "system", r.action, r.resourceType, r.resourceId ?? "", r.ip ?? "", r.hash, r.prevHash ?? ""].map((v) => `"${String(v).replace(/"/g, '""')}"`).join(","))].join("\n");
    const url = URL.createObjectURL(new Blob([csv], { type: "text/csv" }));
    const a = document.createElement("a");
    a.href = url;
    a.download = `necessa-audit-${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Administration" }, { label: "Audit log" }]} />} wide>
      <PageHeader
        title="Audit log"
        description="Append-only and hash-chained: each entry commits to the one before it, so any edit or deletion breaks the chain."
        actions={
          <>
            <Button variant="secondary" onClick={exportCsv} disabled={!rows.length}>
              <Download /> Export CSV
            </Button>
            <Button variant="primary" onClick={() => verify.mutate()} loading={verify.isPending}>
              <Fingerprint /> Verify chain
            </Button>
          </>
        }
      />
      {verify.data ? (
        <div className={cn("mb-4 flex items-center gap-3 rounded-xl px-4 py-3 text-[13px]", verify.data.valid ? "bg-met-soft text-met-fg" : "bg-notmet-soft text-notmet-fg")}>
          {verify.data.valid ? <ShieldCheck className="size-5" /> : <ShieldX className="size-5" />}
          {verify.data.valid ? (
            <span>
              Chain intact — <span className="tabular font-semibold">{fmtNumber(verify.data.checked)}</span> entries verified, no gaps or modifications.
            </span>
          ) : (
            <span>Chain broken at entry #{verify.data.brokenAt}. Investigate immediately.</span>
          )}
        </div>
      ) : null}

      <Card className="overflow-hidden">
        <div className="flex flex-wrap items-center gap-2 border-b border-border px-3 py-2">
          <div className="w-full max-w-xs">
            <Input leading={<Search />} value={action} onChange={(e) => setAction(e.target.value)} placeholder="Action contains… e.g. reveal, override" className="h-8" aria-label="Filter by action" />
          </div>
          <Select size="sm" className="w-48" value={rt} onValueChange={setRt} aria-label="Resource type" options={[{ value: "all", label: "All resources" }, ...RESOURCE_TYPES.map((r) => ({ value: r, label: r }))]} />
          <Select size="sm" className="w-48" value={actor} onValueChange={setActor} aria-label="Actor" options={[{ value: "all", label: "Anyone" }, { value: "system", label: "System" }, ...(members.data ?? []).map((m) => ({ value: m.id, label: m.fullName }))]} />
        </div>
        <CardBody className="px-0 pb-0">
          {audit.isPending ? (
            <Skeleton className="m-4 h-60" />
          ) : rows.length === 0 ? (
            <EmptyState compact art="shield" title="No matching events" />
          ) : (
            <div className="overflow-x-auto">
              <table className="w-full text-[13px]">
                <thead className="text-xs text-muted">
                  <tr>
                    {["#", "When", "Actor", "Action", "Resource", "Hash"].map((h) => (
                      <th key={h} className="px-4 py-2 text-left font-medium">
                        {h}
                      </th>
                    ))}
                  </tr>
                </thead>
                <tbody>
                  {rows.map((r) => (
                    <tr key={r.id} onClick={() => setOpen(r)} className="cursor-pointer border-t border-border/70 hover:bg-surface-2/60">
                      <td className="tabular px-4 py-2 font-mono text-xs text-subtle">{r.id}</td>
                      <td className="whitespace-nowrap px-4 py-2 text-xs text-muted" title={fmtDateTime(r.createdAt)}>
                        {fmtRelative(r.createdAt)}
                      </td>
                      <td className="px-4 py-2">
                        <span className="flex items-center gap-2 whitespace-nowrap">
                          <Avatar name={r.actor?.fullName ?? "System"} color={r.actor?.avatarColor ?? "var(--degraded)"} size={20} />
                          {r.actor?.fullName ?? <span className="text-muted">System</span>}
                        </span>
                      </td>
                      <td className="px-4 py-2">
                        <Badge tone={/reveal|quarantine|override|delete|remove|rollback/.test(r.action) ? "insufficient" : "neutral"} className="font-mono">
                          {r.action}
                        </Badge>
                      </td>
                      <td className="px-4 py-2 font-mono text-xs text-muted">
                        {r.resourceType}
                        {r.resourceId ? `/${r.resourceId}` : ""}
                      </td>
                      <td className="px-4 py-2 font-mono text-[11px] text-subtle">{r.hash.slice(0, 12)}…</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </CardBody>
      </Card>

      <Sheet open={!!open} onOpenChange={(v) => !v && setOpen(null)}>
        {open ? (
          <SheetContent title={`Audit entry #${open.id}`} description={fmtDateTime(open.createdAt)}>
            <div className="grid gap-4 p-5 text-[13px]">
              <div className="grid gap-1">
                <span className="text-xs text-muted">Action</span>
                <span className="font-mono">{open.action}</span>
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted">Actor</span>
                <span>
                  {open.actor?.fullName ?? "System"} · {open.actorType}
                </span>
                {open.ip ? <span className="font-mono text-xs text-subtle">{open.ip} · {open.userAgent}</span> : null}
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted">Resource</span>
                <span className="font-mono text-xs">
                  {open.resourceType}/{open.resourceId ?? "—"}
                </span>
              </div>
              <div className="grid gap-1">
                <span className="text-xs text-muted">Metadata</span>
                <pre className="overflow-x-auto rounded-lg bg-surface-2 p-3 font-mono text-[11.5px]">{JSON.stringify(open.metadata, null, 2)}</pre>
              </div>
              <div className="grid gap-2 rounded-lg border border-border p-3">
                <span className="flex items-center gap-1.5 text-xs font-medium text-muted">
                  <Link2 className="size-3.5" /> Hash chain
                </span>
                <span className="grid gap-0.5">
                  <span className="text-[11px] text-subtle">prev_hash</span>
                  <code className="break-all font-mono text-[11px] text-muted">{open.prevHash ?? "GENESIS"}</code>
                </span>
                <span className="grid gap-0.5">
                  <span className="text-[11px] text-subtle">hash = sha256(prev_hash ‖ canonical_json(entry))</span>
                  <code className="break-all font-mono text-[11px] text-fg">{open.hash}</code>
                </span>
              </div>
            </div>
          </SheetContent>
        ) : null}
      </Sheet>
    </AppPage>
  );
}
