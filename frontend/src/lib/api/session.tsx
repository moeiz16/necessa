"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useSyncExternalStore, type ReactNode } from "react";
import { ApiError, api, isDemoMode, onDemoModeChange, setDemoMode } from "./client";
import { qk } from "./hooks";
import type { LoginResponse, Me, Permission } from "./types";

export function useMe() {
  return useQuery({
    queryKey: qk.me,
    queryFn: async () => {
      try {
        return await api.get<Me>("/auth/me");
      } catch (e) {
        if (e instanceof ApiError && e.status === 401) return null;
        throw e;
      }
    },
    retry: false,
    staleTime: 60_000,
  });
}

export function useSession() {
  const qc = useQueryClient();
  const q = useMe();
  const me = q.data ?? null;
  const status: "loading" | "authenticated" | "unauthenticated" | "error" = q.isPending
    ? "loading"
    : q.isError
      ? "error"
      : me
        ? "authenticated"
        : "unauthenticated";

  const login = useCallback(
    async (body: { email: string; password: string; mfaCode?: string }) => {
      const res = await api.post<LoginResponse & Partial<Me>>("/auth/login", body);
      if (res.mfaRequired) return { mfaRequired: true as const };
      await qc.invalidateQueries({ queryKey: qk.me });
      return { mfaRequired: false as const };
    },
    [qc],
  );

  const logout = useCallback(async () => {
    try {
      await api.post("/auth/logout");
    } finally {
      qc.clear();
      await qc.invalidateQueries({ queryKey: qk.me });
    }
  }, [qc]);

  const can = useCallback((perm: Permission) => !!me?.membership?.permissions.includes(perm), [me]);

  return { me, status, error: q.error, login, logout, can, refetch: q.refetch };
}

export function Can({ perm, children, fallback = null }: { perm: Permission; children: ReactNode; fallback?: ReactNode }) {
  const { can } = useSession();
  return <>{can(perm) ? children : fallback}</>;
}

export function useDemoMode() {
  const on = useSyncExternalStore(
    (cb) => {
      const off = onDemoModeChange(cb);
      return () => {
        off();
      };
    },
    () => isDemoMode(),
    () => process.env.NEXT_PUBLIC_DEMO_MODE === "true",
  );
  const qc = useQueryClient();
  const toggle = useCallback(
    (next: boolean) => {
      setDemoMode(next);
      qc.clear();
    },
    [qc],
  );
  return { on, toggle };
}

/** Keeps <html data-demo> in sync — handy for styling and E2E checks. */
export function DemoAttr() {
  const { on } = useDemoMode();
  useEffect(() => {
    document.documentElement.dataset.demo = on ? "true" : "false";
  }, [on]);
  return null;
}
