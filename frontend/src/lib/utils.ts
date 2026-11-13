import { clsx, type ClassValue } from "clsx";
import { twMerge } from "tailwind-merge";

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs));
}

export function sleep(ms: number) {
  return new Promise<void>((r) => setTimeout(r, ms));
}

const HONORIFIC = /^(dr|mr|mrs|ms|mx|prof)\.?$/i;

/** "Dr. Maya Okafor" → ["Maya", "Okafor"]; "Priya Natarajan, RN" → ["Priya", "Natarajan"]. */
export function nameParts(name?: string | null): string[] {
  if (!name) return [];
  return name
    .split(",")[0]!
    .trim()
    .split(/\s+/)
    .filter((p) => p && !HONORIFIC.test(p));
}

export function initials(name?: string | null) {
  const parts = nameParts(name);
  if (!parts.length) return "?";
  if (parts.length === 1) return parts[0]!.slice(0, 2).toUpperCase();
  return (parts[0]![0]! + parts[parts.length - 1]![0]!).toUpperCase();
}

/** Given name for greetings, honorific-aware ("Dr. Maya Okafor" → "Maya"). */
export function firstName(name?: string | null) {
  return nameParts(name)[0] ?? "";
}

/** Short display name for dense lists ("Dr. Sam Whitfield" → "Dr. Whitfield", "Jordan Reyes" → "Jordan R."). */
export function shortName(name?: string | null) {
  if (!name) return "";
  const parts = nameParts(name);
  if (/^dr\.?\s/i.test(name.trim())) return `Dr. ${parts[parts.length - 1] ?? ""}`.trim();
  return parts.length > 1 ? `${parts[0]} ${parts[parts.length - 1]![0]}.` : (parts[0] ?? name);
}

export function uid(prefix = "") {
  const rnd =
    typeof crypto !== "undefined" && "randomUUID" in crypto
      ? crypto.randomUUID()
      : `${Date.now().toString(16)}-${Math.random().toString(16).slice(2)}`;
  return prefix ? `${prefix}_${rnd}` : rnd;
}

export function clamp(n: number, min: number, max: number) {
  return Math.min(max, Math.max(min, n));
}

export function safeLocalStorage() {
  try {
    if (typeof window === "undefined") return null;
    const k = "__necessa_probe__";
    window.localStorage.setItem(k, "1");
    window.localStorage.removeItem(k);
    return window.localStorage;
  } catch {
    return null;
  }
}

export function lsGet<T>(key: string, fallback: T): T {
  const ls = safeLocalStorage();
  if (!ls) return fallback;
  try {
    const raw = ls.getItem(key);
    return raw ? (JSON.parse(raw) as T) : fallback;
  } catch {
    return fallback;
  }
}

export function lsSet(key: string, value: unknown) {
  const ls = safeLocalStorage();
  if (!ls) return;
  try {
    ls.setItem(key, JSON.stringify(value));
  } catch {
    /* quota or privacy mode — ignore */
  }
}

export function lsRemove(key: string) {
  const ls = safeLocalStorage();
  try {
    ls?.removeItem(key);
  } catch {
    /* ignore */
  }
}
