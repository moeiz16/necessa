"use client";

import { useQueryClient } from "@tanstack/react-query";
import type { ColumnDef } from "@tanstack/react-table";
import { ArrowRight, FilePlus2, Rows3, Rows4, Search, UserRoundPlus, X } from "lucide-react";
import Link from "next/link";
import { useRouter, useSearchParams } from "next/navigation";
import { Suspense, useCallback, useEffect, useMemo, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage } from "@/lib/api/client";
import { useCaseStats, useCases, useMembers } from "@/lib/api/hooks";
import { Can, useSession } from "@/lib/api/session";
import type { CaseSummary } from "@/lib/api/types";
import { fmtDate, fmtRelative, PAYER_LABEL, slaParts } from "@/lib/format";
import { AppPage } from "@/components/shell/app-shell";
import { CodeChip, PayerChip, PriorityChip, ReadinessRing, SlaTimer, StatusChip } from "@/components/domain/verdict";
import { Button } from "@/components/ui/button";
import { Segmented, Select } from "@/components/ui/controls";
import { DataTable } from "@/components/ui/data-table";
import { Avatar, Breadcrumb, Kbd, PageHeader } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { Input } from "@/components/ui/input";
import { Dropdown, DropdownContent, DropdownItem, DropdownLabel, DropdownTrigger, HoverCard, HoverCardContent, HoverCardTrigger } from "@/components/ui/overlays";
import { cn } from "@/lib/utils";

const OPEN = "draft,evaluating,needs_review,ready,submitted,pending_payer,appealing";
const VIEWS = [
  { id: "open", label: "All open", query: { status: OPEN } },
  { id: "mine", label: "My cases", query: { assignee: "me" } },
  { id: "due", label: "Due soon", query: { status: "draft,evaluating,needs_review,ready,submitted", dueBefore: "" } },
  { id: "review", label: "Needs review", query: { status: "needs_review" } },
  { id: "gaps", label: "Gaps", query: { readiness: "gaps" } },
  { id: "ready", label: "Ready", query: { status: "ready" } },
  { id: "denied", label: "Denied & appeals", query: { status: "denied,appealing" } },
  { id: "all", label: "Everything", query: {} },
] as const;

const DENSITY_KEY = "necessa.cases.density";

function CasePreview({ c, children }: { c: CaseSummary; children: React.ReactNode }) {
  const sla = slaParts(c.dueAt);
  return (
    <HoverCard openDelay={450} closeDelay={80}>
      <HoverCardTrigger asChild>{children}</HoverCardTrigger>
      <HoverCardContent side="right" align="start" sideOffset={12} className="w-80 p-4">
          <div className="flex items-start gap-3">
            <ReadinessRing size={44} stroke={4} readiness={c.readiness} score={c.readinessScore} />
            <div className="min-w-0">
              <p className="font-mono text-[11px] text-subtle">{c.number}</p>
              <p className="text-[13px] font-semibold leading-snug text-fg">{c.title}</p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5">
                <StatusChip status={c.status} />
                <PriorityChip priority={c.priority} />
              </div>
            </div>
          </div>
          <dl className="mt-3 grid grid-cols-[96px_1fr] gap-x-3 gap-y-1.5 text-xs">
            <dt className="text-subtle">Patient</dt>
            <dd className="text-fg">
              {c.patient.displayName} · {c.patient.sex}, {new Date().getFullYear() - c.patient.birthYear}
            </dd>
            <dt className="text-subtle">Payer</dt>
            <dd className="text-fg">
              {c.payerName} · {c.state}
            </dd>
            <dt className="text-subtle">Date of service</dt>
            <dd className="tabular text-fg">{fmtDate(c.dateOfService)}</dd>
            <dt className="text-subtle">Payer clock</dt>
            <dd className={cn("tabular", sla?.overdue ? "text-notmet-fg" : sla?.tone === "warn" ? "text-insufficient-fg" : "text-fg")}>{sla ? (sla.overdue ? `${sla.label} overdue` : `${sla.label} left`) : "—"}</dd>
            <dt className="text-subtle">Codes</dt>
            <dd className="flex flex-wrap gap-1">
              {[...c.serviceCodes, ...c.dxCodes].slice(0, 4).map((s) => (
                <CodeChip key={s} code={s} />
              ))}
            </dd>
            <dt className="text-subtle">Assignee</dt>
            <dd className="text-fg">{c.assignee?.fullName ?? "Unassigned"}</dd>
          </dl>
          <p className="mt-3 flex items-center justify-between border-t border-border pt-2 text-[11px] text-subtle">
            Updated {fmtRelative(c.updatedAt)}
            <span className="inline-flex items-center gap-1 font-medium text-brand-fg">
              Open <ArrowRight className="size-3" />
            </span>
          </p>
      </HoverCardContent>
    </HoverCard>
  );
}

function CasesInner() {
  const router = useRouter();
  const params = useSearchParams();
  const qc = useQueryClient();
  const view = (VIEWS.find((v) => v.id === params.get("view")) ?? VIEWS[0])!;
  const [q, setQ] = useState("");
  const [payer, setPayer] = useState("all");
  const [priority, setPriority] = useState("all");
  const [selected, setSelected] = useState<CaseSummary[]>([]);
  const [dense, setDense] = useState(false);
  const [assigning, setAssigning] = useState(false);
  const tableRef = useRef<HTMLDivElement>(null);
  const { can } = useSession();
  const members = useMembers();
  const stats = useCaseStats();

  useEffect(() => {
    try {
      setDense(localStorage.getItem(DENSITY_KEY) === "compact");
    } catch {
      /* ignore */
    }
  }, []);
  const changeDensity = (v: string) => {
    setDense(v === "compact");
    try {
      localStorage.setItem(DENSITY_KEY, v);
    } catch {
      /* ignore */
    }
  };

  const query = useMemo(() => {
    const base: Record<string, string> = { ...view.query };
    if (view.id === "due") base.dueBefore = new Date(Date.now() + 48 * 3600_000).toISOString();
    if (payer !== "all") base.payerType = payer;
    if (priority !== "all") base.priority = priority;
    base.sort = view.id === "due" ? "dueAt" : "-updatedAt";
    return base;
  }, [view, payer, priority]);
  const cases = useCases(query);

  const viewCount = (id: string): number | null => {
    const s = stats.data;
    if (!s) return null;
    const by = s.byStatus ?? {};
    const sum = (keys: string) => keys.split(",").reduce((a, k) => a + (by[k] ?? 0), 0);
    if (id === "open") return sum(OPEN);
    if (id === "review") return by.needs_review ?? 0;
    if (id === "ready") return by.ready ?? 0;
    if (id === "denied") return sum("denied,appealing");
    if (id === "gaps") return s.byReadiness?.gaps ?? 0;
    if (id === "all") return s.total;
    return null;
  };

  /** j/k move between rows, x toggles selection, Enter opens (handled by the row). */
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (e.metaKey || e.ctrlKey || e.altKey || (t && (t.isContentEditable || ["INPUT", "TEXTAREA", "SELECT"].includes(t.tagName)))) return;
      if (!["j", "k", "x"].includes(e.key)) return;
      const rows = Array.from(tableRef.current?.querySelectorAll<HTMLTableRowElement>("tbody tr[tabindex='0']") ?? []);
      if (!rows.length) return;
      const idx = rows.findIndex((r) => r === document.activeElement);
      if (e.key === "x") {
        if (idx >= 0) rows[idx]!.querySelector<HTMLButtonElement>("button[role='checkbox']")?.click();
        return;
      }
      e.preventDefault();
      const next = e.key === "j" ? Math.min(rows.length - 1, idx + 1) : Math.max(0, idx < 0 ? 0 : idx - 1);
      rows[next]!.focus();
      rows[next]!.scrollIntoView({ block: "nearest" });
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);

  const bulkAssign = useCallback(
    async (assigneeId: string | null, label: string) => {
      const previous = selected.map((c) => ({ id: c.id, assigneeId: c.assignee?.id ?? null }));
      setAssigning(true);
      try {
        await Promise.all(previous.map((p) => api.patch(`/cases/${p.id}`, { assigneeId })));
        qc.invalidateQueries({ queryKey: ["cases"] });
        toast.success(assigneeId ? `Assigned ${previous.length} case${previous.length > 1 ? "s" : ""} to ${label}` : `Unassigned ${previous.length} case${previous.length > 1 ? "s" : ""}`, {
          action: {
            label: "Undo",
            onClick: async () => {
              await Promise.all(previous.map((p) => api.patch(`/cases/${p.id}`, { assigneeId: p.assigneeId })));
              qc.invalidateQueries({ queryKey: ["cases"] });
              toast.message("Assignment restored");
            },
          },
        });
      } catch (e) {
        toast.error(errorMessage(e));
      } finally {
        setAssigning(false);
      }
    },
    [selected, qc],
  );

  const columns = useMemo<ColumnDef<CaseSummary, unknown>[]>(
    () => [
      {
        id: "case",
        header: "Case",
        accessorFn: (c) => `${c.number} ${c.title} ${c.patient.displayName} ${c.serviceCodes.join(" ")} ${c.dxCodes.join(" ")}`,
        cell: ({ row: { original: c } }) => (
          <CasePreview c={c}>
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
          </CasePreview>
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
      {
        id: "sla",
        header: "Payer clock",
        accessorFn: (c) => c.dueAt ?? "9999",
        cell: ({ row }) => (["approved", "closed", "denied"].includes(row.original.status) ? <span className="text-xs text-subtle">—</span> : <SlaTimer dueAt={row.original.dueAt} compact />),
      },
      { id: "updated", header: "Updated", accessorKey: "updatedAt", cell: ({ getValue }) => <span className="whitespace-nowrap text-xs text-subtle">{fmtRelative(getValue() as string)}</span> },
    ],
    [],
  );

  const items = cases.data?.items ?? [];
  const assignable = (members.data ?? []).filter((m) => ["coordinator", "clinician", "reviewer", "rcm_manager", "admin", "owner"].includes(m.role));

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Cases" }]} />} wide>
      <PageHeader
        title="Cases"
        description="Every prior authorization and appeal in flight — documentation readiness and payer clocks at a glance."
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
        {VIEWS.map((v) => {
          const n = viewCount(v.id);
          const active = v.id === view.id;
          return (
            <button
              key={v.id}
              role="tab"
              aria-selected={active}
              onClick={() => router.replace(`/cases?view=${v.id}`)}
              className={cn(
                "flex h-7 shrink-0 items-center gap-1.5 rounded-full px-3 text-[13px] font-medium outline-none transition-colors focus-visible:ring-2 focus-visible:ring-brand/30",
                active ? "bg-fg text-bg" : "text-muted hover:bg-surface-2 hover:text-fg",
              )}
            >
              {v.label}
              {n != null ? <span className={cn("tabular rounded-full px-1.5 text-[11px]", active ? "bg-bg/15 text-bg" : "bg-surface-2 text-subtle")}>{n}</span> : null}
            </button>
          );
        })}
      </div>

      <div ref={tableRef}>
        <DataTable
          data={items}
          columns={columns}
          globalFilter={q}
          getRowId={(c) => c.id}
          selectable={can("cases:write")}
          onSelectionChange={setSelected}
          onRowClick={(c) => router.push(`/cases/${c.id}`)}
          initialHidden={{ updated: false }}
          dense={dense}
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
              <Segmented
                value={dense ? "compact" : "comfortable"}
                onValueChange={changeDensity}
                options={[
                  { value: "comfortable", label: <span className="sr-only">Comfortable rows</span>, icon: <Rows3 /> },
                  { value: "compact", label: <span className="sr-only">Compact rows</span>, icon: <Rows4 /> },
                ]}
              />
              {selected.length ? (
                <div className="flex items-center gap-2 rounded-md bg-brand-soft px-2 py-1 text-[13px] text-brand-fg">
                  <span className="tabular font-medium">{selected.length} selected</span>
                  <Dropdown>
                    <DropdownTrigger asChild>
                      <Button size="xs" variant="primary" loading={assigning}>
                        <UserRoundPlus /> Assign
                      </Button>
                    </DropdownTrigger>
                    <DropdownContent align="start">
                      <DropdownLabel>Assign {selected.length} to</DropdownLabel>
                      {assignable.map((m) => (
                        <DropdownItem key={m.id} onSelect={() => bulkAssign(m.id, m.fullName)}>
                          <Avatar name={m.fullName} color={m.avatarColor} size={18} /> {m.fullName}
                        </DropdownItem>
                      ))}
                      <DropdownItem onSelect={() => bulkAssign(null, "")}>
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
      </div>
      <p className="mt-3 hidden items-center gap-3 text-xs text-subtle md:flex">
        <span className="flex items-center gap-1">
          <Kbd>j</Kbd>
          <Kbd>k</Kbd> move
        </span>
        <span className="flex items-center gap-1">
          <Kbd>↵</Kbd> open
        </span>
        {can("cases:write") ? (
          <span className="flex items-center gap-1">
            <Kbd>x</Kbd> select
          </span>
        ) : null}
        <span>· hover a case for a preview</span>
      </p>
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
