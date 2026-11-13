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
  aggregate?: { readiness: Readiness; readinessScore: number; tree: TreeResult };
  gaps?: Gap[];
  error?: string;
  log: { at: number; text: string }[];
}

const EMPTY: LiveEvaluation = { running: false, policies: [], criteriaCount: 0, criteria: [], log: [] };

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

  const listen = useCallback(async () => {
    ctrl.current?.abort();
    const ac = new AbortController();
    ctrl.current = ac;
    const log = (text: string) => setLive((l) => ({ ...l, log: [...l.log, { at: Date.now(), text }] }));
    try {
      await stream(`/cases/${caseId}/events`, {
        signal: ac.signal,
        onEvent: ({ event, data }) => {
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
                criteria: [...l.criteria.filter((c) => c.criterionId !== data.criterionId), { criterionId: String(data.criterionId), text: String(data.text), treePath: String(data.treePath), state: "running", evidence: [] }],
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
              setLive((l) => ({ ...l, aggregate: { readiness: data.readiness as Readiness, readinessScore: Number(data.readinessScore), tree: data.tree as TreeResult } }));
              break;
            case "evaluation.gaps":
              setLive((l) => ({ ...l, gaps: data.gaps as Gap[] }));
              break;
            case "evaluation.completed": {
              const ev = data.evaluation as Evaluation;
              qc.setQueryData(qk.evaluation(caseId, ev.id), ev);
              setLive((l) => ({ ...l, running: false }));
              invalidate();
              toast.success("Evaluation complete", { description: `Readiness ${Math.round((ev.readinessScore ?? 0) * 100)}% · ${ev.gaps.length} gap${ev.gaps.length === 1 ? "" : "s"} to review` });
              ac.abort();
              break;
            }
            case "evaluation.failed":
              setLive((l) => ({ ...l, running: false, error: String(data.error) }));
              invalidate();
              toast.error("Evaluation could not finish", { description: String(data.error) });
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
              toast.success("Draft ready", { description: "Review the citations, then send for clinician approval." });
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
  }, [caseId, qc, invalidate]);

  const evaluate = useCallback(async () => {
    setLive({ ...EMPTY, running: true, message: "Queued…" });
    try {
      await api.post(`/cases/${caseId}/evaluate`, {});
      qc.invalidateQueries({ queryKey: qk.case(caseId) });
      await listen();
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
        await listen();
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
