"use client";

import { CalendarClock, Columns3, Gavel, List, Target, TrendingUp } from "lucide-react";
import Link from "next/link";
import { useMemo, useState } from "react";
import { useAllDenials } from "@/lib/api/hooks";
import type { Denial } from "@/lib/api/types";
import { fmtDate, fmtPct, titleCase } from "@/lib/format";
import { cn } from "@/lib/utils";
import { AppPage } from "@/components/shell/app-shell";
import { daysLeft, DENIAL_STATUS_TONE } from "@/components/cases/denials-panel";
import { Segmented } from "@/components/ui/controls";
import { Badge, Breadcrumb, Card, PageHeader, Skeleton } from "@/components/ui/display";
import { EmptyState } from "@/components/ui/empty";
import { StatCard } from "@/components/ui/widgets";

const COLUMNS: { status: Denial["status"][]; label: string }[] = [
  { status: ["new", "analyzing"], label: "New" },
  { status: ["appeal_drafted"], label: "Appeal drafted" },
  { status: ["appealed"], label: "Appealed" },
  { status: ["overturned"], label: "Overturned" },
  { status: ["upheld"], label: "Upheld" },
];

function DenialCard({ d }: { d: Denial }) {
  const left = daysLeft(d.appealDeadline);
  const closed = ["overturned", "upheld"].includes(d.status);
  return (
    <Link href={`/cases/${d.caseId}?tab=denials`} className="grid gap-2 rounded-lg border border-border bg-surface p-3 shadow-e1 transition-shadow hover:shadow-e2">
      <div className="flex items-center gap-1.5">
        <span className="font-mono text-[11px] text-subtle">{d.caseNumber}</span>
        <span className="ml-auto flex gap-1">
          {d.carcCodes.map((c) => (
            <Badge key={c} tone="outline" size="xs" className="font-mono">
              {c}
            </Badge>
          ))}
        </span>
      </div>
      <p className="text-[13px] font-medium leading-snug text-fg">{d.caseTitle}</p>
      <p className="line-clamp-2 text-xs text-muted">{d.reasonText}</p>
      {d.mappedCriteria[0] ? (
        <p className="flex items-center gap-1.5 text-xs text-brand-fg">
          <Target className="size-3" /> {d.mappedCriteria[0].criterionId} · {d.mappedCriteria[0].text}
        </p>
      ) : null}
      <div className="flex items-center justify-between border-t border-border/70 pt-2 text-xs">
        <span className="text-muted">{d.payerName}</span>
        {closed ? (
          <span className="text-subtle">{fmtDate(d.receivedAt)}</span>
        ) : (
          <span className={cn("flex items-center gap-1 font-medium", left < 30 ? "text-notmet-fg" : "text-muted")}>
            <CalendarClock className="size-3.5" /> {left} d left
          </span>
        )}
      </div>
    </Link>
  );
}

export default function DenialsPage() {
  const denials = useAllDenials();
  const [view, setView] = useState<"board" | "list">("board");
  const list = useMemo(() => denials.data ?? [], [denials.data]);
  const open = list.filter((d) => !["overturned", "upheld"].includes(d.status));
  const decided = list.filter((d) => ["overturned", "upheld"].includes(d.status));
  const overturnRate = decided.length ? decided.filter((d) => d.status === "overturned").length / decided.length : null;
  const dueSoon = open.filter((d) => daysLeft(d.appealDeadline) < 30).length;

  return (
    <AppPage crumbs={<Breadcrumb items={[{ label: "Denials & appeals" }]} />} wide>
      <PageHeader
        title="Denials & appeals"
        description="Every denial mapped to the policy criteria it cites, with redetermination deadlines and drafted appeals."
        actions={
          <Segmented
            value={view}
            onValueChange={setView}
            options={[
              { value: "board", label: "Board", icon: <Columns3 /> },
              { value: "list", label: "List", icon: <List /> },
            ]}
          />
        }
      />
      <div className="mb-5 grid gap-3 sm:grid-cols-3">
        <StatCard label="Open denials" value={open.length} icon={<Gavel />} />
        <StatCard label="Appeal deadlines within 30 days" value={dueSoon} icon={<CalendarClock />} />
        <StatCard label="Overturn rate" value={overturnRate === null ? "—" : fmtPct(overturnRate)} icon={<TrendingUp />} hint="Decided appeals only" />
      </div>

      {denials.isPending ? (
        <div className="grid gap-3 md:grid-cols-5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-72 rounded-xl" />)}</div>
      ) : list.length === 0 ? (
        <Card>
          <EmptyState art="inbox" title="No denials" description="When a payer denies a case, record the notice on the case. It will appear here with its mapped criteria." />
        </Card>
      ) : view === "board" ? (
        <div className="grid gap-3 overflow-x-auto pb-2 md:grid-cols-5">
          {COLUMNS.map((col) => {
            const items = list.filter((d) => col.status.includes(d.status));
            return (
              <div key={col.label} className="flex min-w-[240px] flex-col gap-2 rounded-xl bg-surface-2/50 p-2">
                <div className="flex items-center justify-between px-1.5 py-1">
                  <span className="text-xs font-semibold text-fg">{col.label}</span>
                  <span className="tabular rounded-full bg-surface px-1.5 text-[11px] text-muted shadow-e1">{items.length}</span>
                </div>
                {items.map((d) => (
                  <DenialCard key={d.id} d={d} />
                ))}
                {items.length === 0 ? <p className="px-2 py-6 text-center text-xs text-subtle">Nothing here</p> : null}
              </div>
            );
          })}
        </div>
      ) : (
        <Card className="overflow-hidden">
          <table className="w-full text-[13px]">
            <thead className="bg-surface-2 text-xs text-muted">
              <tr>
                {["Case", "Category", "Codes", "Mapped criterion", "Status", "Deadline"].map((h) => (
                  <th key={h} className="px-3 py-2 text-left font-medium">
                    {h}
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              {list.map((d) => (
                <tr key={d.id} className="border-t border-border/70">
                  <td className="px-3 py-2.5">
                    <Link href={`/cases/${d.caseId}?tab=denials`} className="grid hover:text-brand">
                      <span className="font-medium text-fg">{d.caseTitle}</span>
                      <span className="font-mono text-xs text-subtle">{d.caseNumber}</span>
                    </Link>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{titleCase(d.category)}</td>
                  <td className="px-3 py-2.5 font-mono text-xs">{[...d.carcCodes.map((c) => `CARC ${c}`), ...d.rarcCodes].join(" · ")}</td>
                  <td className="px-3 py-2.5 text-muted">{d.mappedCriteria[0] ? `${d.mappedCriteria[0].criterionId} · ${d.mappedCriteria[0].text}` : "—"}</td>
                  <td className="px-3 py-2.5">
                    <Badge tone={DENIAL_STATUS_TONE[d.status]} dot>
                      {titleCase(d.status)}
                    </Badge>
                  </td>
                  <td className="px-3 py-2.5 text-muted">{fmtDate(d.appealDeadline)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </Card>
      )}
    </AppPage>
  );
}
