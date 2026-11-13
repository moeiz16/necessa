"use client";

import type { ColumnDef } from "@tanstack/react-table";
import { FilePlus2, Search, UserRoundPlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useMemo, useState } from "react";
import { useBulkAssign, useCases, useMembers } from "@/lib/api/hooks";
import { Can, useSession } from "@/lib/api/session";
import type { CaseSummary } from "@/lib/api/types";
import { fmtDate, fmtRelative, PAYER_LABEL } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { CodeChip, PayerChip, PriorityChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Select } from "@/components/ui/controls";
import { DataTable } from "@/components/ui/data-table";
import { Avatar, Breadcrumb, PageHeader } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

const VIEWS = [
  { id: "open", label: "All open", query: { status: "draft,evaluating,needs_review,ready,submitted,pending_payer,appealing" } },
  { id: "mine", label: "My cases", query: { assignee: "me" } },
  { id: "due", label: "Due soon", query: { status: "draft,evaluating,needs_review,ready,submitted", dueBefore: "" } },
  { id: "review", label: "Needs review", query: { status: "needs_review" } },
  { id: "gaps", label: "Gaps", query: { readiness: "gaps" } },
  { id: "ready", label: "Ready", query: { status: "ready" } },
  { id: "denied", label: "Denied & appeals", query: { status: "denied,appealing" } },
  { id: "all", label: "Everything", query: {} },
] as const;

function CasesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const view = (VIEWS.find((v) => v.id === params.get("view")) ?? VIEWS[0])!;
  const [q, setQ] = useState("");
  const [payer, setPayer] = useState("all");
  const [priority, setPriority] = useState("all");
  const [selected, setSelected] = useState<CaseSummary[]>([]);
  const { can } = useSession();
  const members = useMembers();
  const bulk = useBulkAssign();

  const query = useMemo(() => {
    const base: Record<string, string> = { ...view.query };
    if (view.id === "due") base.dueBefore = new Date(Date.now() + 48 * 3600_000).toISOString();
    if (payer !== "all") base.payerType = payer;
    if (priority !== "all") base.priority = priority;
    base.sort = view.id === "due" ? "dueAt" : "-updatedAt";
    return base;
  }, [view, payer, priority]);
  const cases = useCases(query);

  const columns = useMemo<ColumnDef<CaseSummary, unknown>[]>(
    () => [
      {
        id: "case",
        header: "Case",
        accessorFn: (c) => `${c.number} ${c.title} ${c.patient.displayName}`,
        cell: ({ row: { original: c } }) => (
          <div className="flex min-w-[260px] items-center gap-3">
            <ReadinessRing size={30} stroke={3} readiness={c.readiness} score={c.readinessScore} />
            <div className="min-w-0">
              <div className="flex items-center gap-1.5">
                <span className="truncate font-medium text-fg">{c.title}</span>
                <PriorityChip priority={c.priority} />
              </div>
              <p className="truncate text-xs text-muted">
                <span className="font-mono">{c.number}</span> · {c.patient.displayName} · {c.patient.sex}, {new Date().getFullYear() - c.patient.birthYear}
              </p>
            </div>
          </div>
        ),
      },
      { id: "status", header: "Status", accessorKey: "status", cell: ({ row }) => <StatusChip status={row.original.status} /> },
      {
        id: "payer",
        header: "Payer",
        accessorFn: (c) => c.payerName,
        cell: ({ row: { original: c } }) => (
          <div className="grid min-w-[150px]">
            <PayerChip payerType={c.payerType} payerName={c.payerName} />
            <span className="pl-3 text-[11px] text-subtle">
              {PAYER_LABEL[c.payerType]} · {c.state}
            </span>
          </div>
        ),
      },
      {
        id: "codes",
        header: "Codes",
        enableSorting: false,
        cell: ({ row: { original: c } }) => (
          <div className="flex flex-wrap gap-1">
            {c.serviceCodes.slice(0, 2).map((s) => (
              <CodeChip key={s} code={s} />
            ))}
            {c.dxCodes.slice(0, 1).map((s) => (
              <CodeChip key={s} code={s} className="text-muted" />
            ))}
          </div>
        ),
      },
      { id: "dos", header: "Date of service", accessorKey: "dateOfService", cell: ({ getValue }) => <span className="tabular whitespace-nowrap text-muted">{fmtDate(getValue() as string, "MMM d")}</span> },
      {
        id: "assignee",
        header: "Assignee",
        accessorFn: (c) => c.assignee?.fullName ?? "",
        cell: ({ row: { original: c } }) =>
          c.assignee ? (
            <span className="flex items-center gap-1.5 whitespace-nowrap text-muted">
              <Avatar name={c.assignee.fullName} color={c.assignee.avatarColor} size={20} />
              <span className="hidden xl:inline">{c.assignee.fullName.split(" ")[0] === "Dr." ? c.assignee.fullName.split(" ").slice(0, 2).join(" ") : c.assignee.fullName.split(" ")[0]}</span>
            </span>
          ) : (
            <span className="text-xs text-subtle">Unassigned</span>
          ),
      },
      { id: "sla", header: "SLA", accessorFn: (c) => c.dueAt ?? "9999", cell: ({ row }) => (["approved", "closed", "denied"].includes(row.original.status) ? <span className="text-xs text-subtle">—</span> : <SlaTimer dueAt={row.original.dueAt} compact />) },
      { id: "updated", header: "Updated", accessorKey: "updatedAt", cell: ({ getValue }) => <span className="whitespace-nowrap text-xs text-subtle">{fmtRelative(getValue() as string)}</span> },
    ],
    [],
  );

  const items = cases.data?.items ?? [];

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Cases" }]} />} wide>
      <PageHeader
        title="Cases"
        description="Every prior authorization and appeal in flight, with documentation readiness and payer clocks."
        actions={
          <Can perm="cases:write">
            <Button asChild variant="primary">
              <Link href="/cases/new">
                <FilePlus2 /> New case
              </Link>
            </Button>
          </Can>
        }
      />

      <div className="-mt-2 mb-3 flex gap-1 overflow-x-auto pb-1 scrollbar-thin" role="tablist" aria-label="Saved views">
        {VIEWS.map((v) => (
          <button
            key={v.id}
            role="tab"
            aria-selected={v.id === view.id}
            onClick={() => router.replace(`/cases?view=${v.id}`)}
            className={cn(
              "h-7 shrink-0 rounded-full px-3 text-[13px] font-medium transition-colors",
              v.id === view.id ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg",
            )}
          >
            {v.label}
          </button>
        ))}
      </div>

      <DataTable
        data={items}
        columns={columns}
        globalFilter={q}
        getRowId={(c) => c.id}
        selectable={can("cases:write")}
        onSelectionChange={setSelected}
        onRowClick={(c) => router.push(`/cases/${c.id}`)}
        initialHidden={{ updated: false }}
        rowClassName={(c) => (c.priority === "expedited" && !["approved", "closed"].includes(c.status) ? "shadow-[inset_2px_0_0_var(--notmet)]" : undefined)}
        toolbar={
          <>
            <div className="w-full max-w-xs">
              <Input leading={<Search />} placeholder="Filter by patient, code, number…" value={q} onChange={(e) => setQ(e.target.value)} className="h-8" aria-label="Filter cases" />
            </div>
            <Select
              size="sm"
              className="w-44"
              value={payer}
              onValueChange={setPayer}
              aria-label="Payer type"
              options={[{ value: "all", label: "All payers" }, ...Object.entries(PAYER_LABEL).map(([value, label]) => ({ value, label }))]}
            />
            <Select size="sm" className="w-36" value={priority} onValueChange={setPriority} aria-label="Priority" options={[{ value: "all", label: "Any priority" }, { value: "expedited", label: "Expedited" }, { value: "standard", label: "Standard" }]} />
            {selected.length ? (
              <div className="flex items-center gap-2 rounded-md bg-brand-soft px-2 py-1 text-[13px] text-brand-fg">
                <span className="tabular font-medium">{selected.length} selected</span>
                <Dropdown>
                  <DropdownTrigger asChild>
                    <Button size="xs" variant="primary">
                      <UserRoundPlus /> Assign
                    </Button>
                  </DropdownTrigger>
                  <DropdownContent align="start">
                    <DropdownLabel>Assign to</DropdownLabel>
                    {(members.data ?? [])
                      .filter((m) => ["coordinator", "clinician", "reviewer", "rcm_manager", "admin"].includes(m.role))
                      .map((m) => (
                        <DropdownItem key={m.id} onSelect={() => bulk.mutate({ ids: selected.map((s) => s.id), assigneeId: m.id })}>
                          <Avatar name={m.fullName} color={m.avatarColor} size={18} /> {m.fullName}
                        </DropdownItem>
                      ))}
                    <DropdownItem onSelect={() => bulk.mutate({ ids: selected.map((s) => s.id), assigneeId: null })}>
                      <X /> Unassign
                    </DropdownItem>
                  </DropdownContent>
                </Dropdown>
              </div>
            ) : null}
          </>
        }
        empty={
          cases.isPending ? (
            <div className="grid gap-2 py-4">{Array.from({ length: 6 }).map((_, i) => <div key={i} className="skeleton h-10 rounded-md" />)}</div>
          ) : (
            <EmptyState
              art="cases"
              title={q ? "No cases match that filter" : "No cases in this view"}
              description={q ? "Try a code, patient initials or case number." : "Create a case to check documentation against payer policy."}
              action={
                can("cases:write") ? (
                  <Button asChild variant="primary" size="sm">
                    <Link href="/cases/new">New case</Link>
                  </Button>
                ) : null
              }
            />
          )
        }
      />
    </AppPage>
  );
}

export default function CasesPage() {
  return (
    <Suspense>
      <CasesInner />
    </Suspense>
  );
}
