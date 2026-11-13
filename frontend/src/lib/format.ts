import { differenceInMinutes, format, formatDistanceToNowStrict, isValid, parseISO } from "date-fns";

export function toDate(v?: string | Date | null): Date | null {
  if (!v) return null;
  const d = typeof v === "string" ? parseISO(v) : v;
  return isValid(d) ? d : null;
}

export function fmtDate(v?: string | Date | null, pattern = "MMM d, yyyy") {
  const d = toDate(v);
  return d ? format(d, pattern) : "—";
}

export function fmtDateTime(v?: string | Date | null) {
  return fmtDate(v, "MMM d, yyyy · h:mm a");
}

export function fmtRelative(v?: string | Date | null) {
  const d = toDate(v);
  if (!d) return "—";
  const mins = Math.abs(differenceInMinutes(new Date(), d));
  if (mins < 1) return "just now";
  return `${formatDistanceToNowStrict(d)} ago`;
}

export function fmtNumber(n?: number | null, opts: Intl.NumberFormatOptions = {}) {
  if (n === null || n === undefined || Number.isNaN(n)) return "—";
  return new Intl.NumberFormat("en-US", opts).format(n);
}

export function fmtCompact(n?: number | null) {
  return fmtNumber(n, { notation: "compact", maximumFractionDigits: 1 });
}

export function fmtPct(n?: number | null, digits = 0) {
  if (n === null || n === undefined) return "—";
  return `${(n * 100).toFixed(digits)}%`;
}

export function fmtMs(ms?: number | null) {
  if (ms === null || ms === undefined) return "—";
  if (ms < 1000) return `${Math.round(ms)} ms`;
  return `${(ms / 1000).toFixed(ms < 10_000 ? 2 : 1)} s`;
}

export function fmtBytes(b?: number | null) {
  if (!b && b !== 0) return "—";
  const u = ["B", "KB", "MB", "GB"];
  let i = 0;
  let v = b;
  while (v >= 1024 && i < u.length - 1) {
    v /= 1024;
    i++;
  }
  return `${v.toFixed(i === 0 ? 0 : 1)} ${u[i]}`;
}

/** Human SLA string for a due date: "in 5h 12m", "overdue 2h". */
export function slaParts(due?: string | null, now = new Date()) {
  const d = toDate(due);
  if (!d) return null;
  const mins = differenceInMinutes(d, now);
  const overdue = mins < 0;
  const abs = Math.abs(mins);
  const days = Math.floor(abs / 1440);
  const hours = Math.floor((abs % 1440) / 60);
  const m = abs % 60;
  const label = days > 0 ? `${days}d ${hours}h` : hours > 0 ? `${hours}h ${m}m` : `${m}m`;
  const tone: "ok" | "warn" | "danger" = overdue ? "danger" : mins < 24 * 60 ? "warn" : "ok";
  return { overdue, label, tone, minutes: mins };
}

export const PAYER_LABEL: Record<string, string> = {
  medicare_ffs: "Medicare FFS",
  medicare_advantage: "Medicare Advantage",
  commercial: "Commercial",
  medicaid: "Medicaid",
};

export const STATUS_LABEL: Record<string, string> = {
  draft: "Draft",
  evaluating: "Evaluating",
  needs_review: "Needs review",
  ready: "Ready to submit",
  submitted: "Submitted",
  pending_payer: "Pending payer",
  approved: "Approved",
  denied: "Denied",
  appealing: "Appealing",
  closed: "Closed",
};

export const ROLE_LABEL: Record<string, string> = {
  owner: "Owner",
  admin: "Admin",
  coordinator: "PA Coordinator",
  clinician: "Clinician",
  reviewer: "Reviewer",
  rcm_manager: "RCM Manager",
  auditor: "Auditor",
};

export function titleCase(s: string) {
  return s.replace(/[_-]+/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
}
