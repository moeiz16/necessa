"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useCallback, useEffect, useRef, useState } from "react";
import { toast } from "sonner";
import { api, errorMessage, stream } from "@/lib/api/client";
import { qk } from "@/lib/api/hooks";
import type { CriterionResult, Evaluation, Evidence, Gap, Letter, LetterKind, PolicyMatch, Readiness, TreeResult } from "@/lib/api/types";

export interface LiveCriterion {
  criterionId: string;
  text: string;
  treePath: string;
  state: "running" | "corrective" | "done";
  evidence: Evidence[];
  result?: CriterionResult;
  corrective?: string;
}

export interface LiveEvaluation {
  running: boolean;
  evaluationId?: string;
  phase?: string;
  message?: string;
  policies: PolicyMatch[];
  criteriaCount: number;
  criteria: LiveCriterion[];
  aggregate?: { readiness: Readiness; readinessScore: number | null; tree: TreeResult };
  gaps?: Gap[];
  error?: string;
  log: { at: number; text: string }[];
}

const EMPTY: LiveEvaluation = { running: false, policies: [], criteriaCount: 0, criteria: [], log: [] };

/**
 * Subscribes to `case:{id}` SSE. The server replays recent channel events to late joiners, which can
 * include a *previous* run's events — so a run only "opens" once its own `evaluation.started` (or
 * `letter.started`) arrives, matched by the id the POST returned. Everything before that is ignored.
 */
export function useCaseStream(caseId: string) {
  const qc = useQueryClient();
  const [live, setLive] = useState<LiveEvaluation>(EMPTY);
  const [draft, setDraft] = useState<{ letterId: string; text: string; running: boolean } | null>(null);
  const ctrl = useRef<AbortController | null>(null);

  useEffect(() => () => ctrl.current?.abort(), []);

  const invalidate = useCallback(() => {
    qc.invalidateQueries({ queryKey: qk.case(caseId) });
    qc.invalidateQueries({ queryKey: ["case", caseId] });
    qc.invalidateQueries({ queryKey: ["cases"] });
    qc.invalidateQueries({ queryKey: qk.notifications });
  }, [qc, caseId]);

  const listen = useCallback(
    async (expect: { evaluationId?: string; letterId?: string }) => {
      ctrl.current?.abort();
      const ac = new AbortController();
      ctrl.current = ac;
      let evalOpen = false; // our run's `evaluation.started` has arrived
      let otherRun = false; // a previous run is being replayed; ignore it until its terminal event
      const log = (text: string) => setLive((l) => ({ ...l, log: [...l.log, { at: Date.now(), text }] }));
      try {
        await stream(`/cases/${caseId}/events`, {
          signal: ac.signal,
          onEvent: ({ event, data }) => {
            if (event.startsWith("evaluation.") || event.startsWith("criterion.")) {
              if (!expect.evaluationId) return;
              if (event === "evaluation.started") {
                if (String(data.evaluationId) === expect.evaluationId) {
                  evalOpen = true;
                  otherRun = false;
                  setLive((l) => ({ ...l, criteria: [], aggregate: undefined, gaps: undefined }));
                } else {
                  otherRun = true;
                  return;
                }
              }
              const terminal = event === "evaluation.completed" || event === "evaluation.failed";
              if (!evalOpen) {
                if (otherRun) {
                  if (terminal) otherRun = false;
                  return;
                }
                // Before our run opens, only phase messages and a pre-start failure can be ours.
                if (event.startsWith("criterion.") || event === "evaluation.completed" || event === "evaluation.aggregate" || event === "evaluation.gaps") return;
              }
            }
            if (event.startsWith("letter.")) {
              if (!expect.letterId) return;
              if (data.letterId !== undefined && String(data.letterId) !== expect.letterId) return;
            }
            switch (event) {
              case "evaluation.phase":
                setLive((l) => ({ ...l, phase: String(data.phase), message: String(data.message ?? "") }));
                log(String(data.message ?? data.phase));
                break;
              case "evaluation.started":
                setLive((l) => ({ ...l, running: true, evaluationId: String(data.evaluationId), policies: (data.policies as PolicyMatch[]) ?? [], criteriaCount: Number(data.criteriaCount ?? 0) }));
                break;
              case "criterion.started":
                setLive((l) => ({
                  ...l,
                  criteria: [...l.criteria.filter((c) => c.criterionId !== data.criterionId), { criterionId: String(data.criterionId), text: String(data.text), treePath: String(data.treePath ?? ""), state: "running", evidence: [] }],
                }));
                break;
              case "criterion.evidence":
                setLive((l) => ({ ...l, criteria: l.criteria.map((c) => (c.criterionId === data.criterionId ? { ...c, evidence: data.evidence as Evidence[] } : c)) }));
                break;
              case "criterion.corrective":
                setLive((l) => ({ ...l, criteria: l.criteria.map((c) => (c.criterionId === data.criterionId ? { ...c, state: "corrective", corrective: String(data.reason) } : c)) }));
                log(`${data.criterionId}: corrective retrieval — ${data.reason}`);
                break;
              case "criterion.verdict": {
                const r = data.result as CriterionResult;
                setLive((l) => ({ ...l, criteria: l.criteria.map((c) => (c.criterionId === r.criterionId ? { ...c, state: "done", result: r, evidence: r.evidence } : c)) }));
                break;
              }
              case "evaluation.aggregate":
                setLive((l) => ({ ...l, aggregate: { readiness: data.readiness as Readiness, readinessScore: data.readinessScore == null ? null : Number(data.readinessScore), tree: data.tree as TreeResult } }));
                break;
              case "evaluation.gaps":
                setLive((l) => ({ ...l, gaps: data.gaps as Gap[] }));
                break;
              case "evaluation.completed": {
                const ev = data.evaluation as Evaluation;
                if (expect.evaluationId && ev?.id && ev.id !== expect.evaluationId) break;
                qc.setQueryData(qk.evaluation(caseId, ev.id), ev);
                setLive((l) => ({ ...l, running: false }));
                invalidate();
                if (!ev.criteria.length) toast.warning("We couldn't check this case yet", { description: "The matching payer policy hasn't been set up in Necessa yet. Ask your administrator to add it." });
                else
                  toast.success("Check complete", {
                    description: `${ev.readinessScore == null ? "Readiness unknown" : `${Math.round(ev.readinessScore * 100)}% of requirements documented`} · ${ev.gaps.length} gap${ev.gaps.length === 1 ? "" : "s"} to review${ev.degraded ? " · rule-based checks only" : ""}`,
                  });
                ac.abort();
                break;
              }
              case "evaluation.failed":
                setLive((l) => ({ ...l, running: false, error: String(data.error) }));
                invalidate();
                toast.error("The check could not finish", { description: "Please try again in a moment." });
                ac.abort();
                break;
              case "letter.started":
                setDraft({ letterId: String(data.letterId), text: "", running: true });
                break;
              case "letter.token":
                setDraft((d) => (d ? { ...d, text: d.text + String(data.text) } : d));
                break;
              case "letter.completed": {
                const letter = data.letter as Letter;
                setDraft((d) => (d ? { ...d, text: letter.contentMd, running: false } : d));
                qc.invalidateQueries({ queryKey: qk.letters(caseId) });
                toast.success("Draft ready", { description: "Check the sources, then send it for clinician approval." });
                ac.abort();
                break;
              }
            }
          },
        });
      } catch (e) {
        if ((e as Error).name !== "AbortError") {
          setLive((l) => ({ ...l, running: false, error: errorMessage(e) }));
          toast.error(errorMessage(e));
        }
      }
    },
    [caseId, qc, invalidate],
  );

  const evaluate = useCallback(async () => {
    setLive({ ...EMPTY, running: true, message: "Starting…", log: [{ at: Date.now(), text: "Evaluation requested" }] });
    try {
      const res = await api.post<{ evaluationId?: string }>(`/cases/${caseId}/evaluate`, {});
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      await listen({ evaluationId: res?.evaluationId });
    } catch (e) {
      setLive({ ...EMPTY, error: errorMessage(e) });
      toast.error(errorMessage(e));
    }
  }, [caseId, listen, qc]);

  const draftLetter = useCallback(
    async (kind: LetterKind) => {
      try {
        const res = await api.post<{ letterId: string }>(`/cases/${caseId}/letters`, { kind });
        setDraft({ letterId: res.letterId, text: "", running: true });
        qc.invalidateQueries({ queryKey: qk.letters(caseId) });
        await listen({ letterId: res.letterId });
        return res.letterId;
      } catch (e) {
        toast.error(errorMessage(e));
        return null;
      }
    },
    [caseId, listen, qc],
  );

  const reset = useCallback(() => setLive(EMPTY), []);

  return { live, evaluate, draft, draftLetter, reset };
}
