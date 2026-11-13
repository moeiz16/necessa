"use client";

import type { Problem, StreamEvent } from "./types";
import { lsGet, lsSet } from "@/lib/utils";

export const API_BASE = process.env.NEXT_PUBLIC_API_BASE || "/api/v1";
const DEMO_ENV = process.env.NEXT_PUBLIC_DEMO_MODE === "true";
const DEMO_KEY = "necessa.demo";

/* ── Errors ─────────────────────────────────────────────────────────────── */
export class ApiError extends Error {
  status: number;
  problem: Problem;
  constructor(problem: Problem) {
    super(problem.detail || problem.title);
    this.name = "ApiError";
    this.status = problem.status;
    this.problem = problem;
  }
  get fieldErrors(): Record<string, string> {
    const out: Record<string, string> = {};
    for (const e of this.problem.errors ?? []) {
      const key = e.field ?? (e.loc ? String(e.loc[e.loc.length - 1]) : "form");
      out[key] = e.msg;
    }
    return out;
  }
}

export class NetworkError extends Error {
  constructor(message = "We couldn’t reach Necessa. Please check your connection and try again.") {
    super(message);
    this.name = "NetworkError";
  }
}

export function errorMessage(err: unknown): string {
  if (err instanceof ApiError) return err.problem.detail || err.problem.title;
  if (err instanceof Error) return err.message;
  return "Something went wrong. Please try again.";
}

/* ── Demo mode switch ───────────────────────────────────────────────────── */
type Listener = () => void;
const listeners = new Set<Listener>();

export function isDemoMode(): boolean {
  if (DEMO_ENV) return true;
  return lsGet<boolean>(DEMO_KEY, false);
}

export function isDemoForced(): boolean {
  return DEMO_ENV;
}

export function setDemoMode(on: boolean) {
  lsSet(DEMO_KEY, on);
  listeners.forEach((l) => l());
}

export function onDemoModeChange(l: Listener): () => void {
  listeners.add(l);
  return () => {
    listeners.delete(l);
  };
}

const unreachableListeners = new Set<Listener>();
export function onBackendUnreachable(l: Listener): () => void {
  unreachableListeners.add(l);
  return () => {
    unreachableListeners.delete(l);
  };
}
function emitUnreachable() {
  unreachableListeners.forEach((l) => l());
}

/* ── CSRF ───────────────────────────────────────────────────────────────── */
function readCookie(name: string): string | null {
  if (typeof document === "undefined") return null;
  const m = document.cookie.match(new RegExp(`(?:^|; )${name}=([^;]*)`));
  return m ? decodeURIComponent(m[1]!) : null;
}

const UNSAFE = new Set(["POST", "PUT", "PATCH", "DELETE"]);

/* ── Core request ───────────────────────────────────────────────────────── */
export type Query = Record<string, string | number | boolean | null | undefined | string[]>;

export function buildPath(path: string, query?: Query) {
  if (!query) return path;
  const sp = new URLSearchParams();
  for (const [k, v] of Object.entries(query)) {
    if (v === undefined || v === null || v === "") continue;
    if (Array.isArray(v)) v.forEach((x) => sp.append(k, x));
    else sp.set(k, String(v));
  }
  const qs = sp.toString();
  return qs ? `${path}?${qs}` : path;
}

export interface RequestOptions {
  method?: string;
  body?: unknown;
  query?: Query;
  signal?: AbortSignal;
  /** raw FormData upload */
  form?: FormData;
}

async function parseError(res: Response): Promise<ApiError> {
  let problem: Problem = { title: res.statusText || "Request failed", status: res.status };
  try {
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) {
      const body = await res.json();
      if (body && typeof body === "object") {
        if ("title" in body) problem = { ...problem, ...body };
        else if ("detail" in body) {
          // FastAPI default error shape
          const detail = (body as { detail: unknown }).detail;
          problem.detail = typeof detail === "string" ? detail : "Validation failed";
          if (Array.isArray(detail)) problem.errors = detail as Problem["errors"];
        }
      }
    }
  } catch {
    /* non-JSON error */
  }
  return new ApiError(problem);
}

let refreshing: Promise<boolean> | null = null;
async function tryRefresh(): Promise<boolean> {
  if (!refreshing) {
    refreshing = fetch(`${API_BASE}/auth/refresh`, { method: "POST", credentials: "include" })
      .then((r) => r.ok)
      .catch(() => false)
      .finally(() => {
        setTimeout(() => (refreshing = null), 0);
      });
  }
  return refreshing;
}

export async function request<T>(path: string, opts: RequestOptions = {}): Promise<T> {
  const method = (opts.method || "GET").toUpperCase();
  if (isDemoMode()) {
    const { demoRequest } = await import("@/lib/demo/handlers");
    return demoRequest<T>(method, path, opts);
  }

  const headers: Record<string, string> = { Accept: "application/json" };
  let body: BodyInit | undefined;
  if (opts.form) body = opts.form;
  else if (opts.body !== undefined) {
    headers["Content-Type"] = "application/json";
    body = JSON.stringify(opts.body);
  }
  if (UNSAFE.has(method)) {
    const csrf = readCookie("necessa_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }

  const url = `${API_BASE}${buildPath(path, opts.query)}`;
  const doFetch = () => fetch(url, { method, headers, body, credentials: "include", signal: opts.signal });

  let res: Response;
  try {
    res = await doFetch();
  } catch (e) {
    if ((e as Error).name === "AbortError") throw e;
    emitUnreachable();
    throw new NetworkError();
  }
  if ([502, 503, 504].includes(res.status) && !res.headers.get("content-type")?.includes("json")) {
    emitUnreachable();
    throw new NetworkError();
  }
  if (res.status === 401 && !path.startsWith("/auth/")) {
    if (await tryRefresh()) res = await doFetch();
  }
  if (!res.ok) throw await parseError(res);
  if (res.status === 204) return undefined as T;
  const ct = res.headers.get("content-type") || "";
  if (ct.includes("json")) return (await res.json()) as T;
  return (await res.text()) as unknown as T;
}

export const api = {
  get: <T>(path: string, query?: Query, signal?: AbortSignal) => request<T>(path, { query, signal }),
  post: <T>(path: string, body?: unknown) => request<T>(path, { method: "POST", body }),
  patch: <T>(path: string, body?: unknown) => request<T>(path, { method: "PATCH", body }),
  del: <T>(path: string) => request<T>(path, { method: "DELETE" }),
  upload: <T>(path: string, form: FormData) => request<T>(path, { method: "POST", form }),
};

/* ── SSE (fetch-based; works for GET and POST streams) ─────────────────── */
export interface StreamOptions {
  method?: "GET" | "POST";
  body?: unknown;
  signal?: AbortSignal;
  onEvent: (e: StreamEvent) => void;
}

export async function stream(path: string, opts: StreamOptions): Promise<void> {
  if (isDemoMode()) {
    const { demoStream } = await import("@/lib/demo/streams");
    for await (const ev of demoStream(opts.method || "GET", path, opts.body, opts.signal)) {
      if (opts.signal?.aborted) return;
      opts.onEvent(ev);
    }
    return;
  }

  const headers: Record<string, string> = { Accept: "text/event-stream" };
  if (opts.body !== undefined) headers["Content-Type"] = "application/json";
  if (opts.method === "POST") {
    const csrf = readCookie("necessa_csrf");
    if (csrf) headers["X-CSRF-Token"] = csrf;
  }
  let res: Response;
  try {
    res = await fetch(`${API_BASE}${path}`, {
      method: opts.method || "GET",
      headers,
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
      credentials: "include",
      signal: opts.signal,
    });
  } catch (e) {
    if ((e as Error).name === "AbortError") return;
    emitUnreachable();
    throw new NetworkError();
  }
  if (!res.ok || !res.body) throw await parseError(res);

  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buffer.slice(0, idx);
        buffer = buffer.slice(idx).replace(/^\r?\n\r?\n/, "");
        const ev = parseSseBlock(raw);
        if (ev) opts.onEvent(ev);
      }
    }
  } catch (e) {
    if ((e as Error).name !== "AbortError") throw e;
  } finally {
    reader.releaseLock();
  }
}

export function parseSseBlock(raw: string): StreamEvent | null {
  let event = "message";
  const data: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (!line || line.startsWith(":")) continue;
    const i = line.indexOf(":");
    const field = i === -1 ? line : line.slice(0, i);
    const value = i === -1 ? "" : line.slice(i + 1).replace(/^ /, "");
    if (field === "event") event = value;
    else if (field === "data") data.push(value);
  }
  if (!data.length) return null;
  try {
    return { event, data: JSON.parse(data.join("\n")) };
  } catch {
    return { event, data: { text: data.join("\n") } };
  }
}
