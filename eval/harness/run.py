"""Evaluation harness entrypoint (thin wrapper around backend/app/ai/evaluation).

    backend/.venv/bin/python eval/harness/run.py --suite verdicts            # offline, $0
    backend/.venv/bin/python eval/harness/run.py --suite safety --fail-on-gate
    backend/.venv/bin/python eval/harness/run.py --suite verdicts --live --limit 40   # free-tier models

Reports are written to eval/reports/<suite>-latest.md (+ timestamped JSON).
"""

from __future__ import annotations

import argparse
import asyncio
import json
import os
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parents[2]
sys.path.insert(0, str(ROOT / "backend"))
os.environ.setdefault("LLM_FAKE", "false")


def main() -> int:
    ap = argparse.ArgumentParser()
    ap.add_argument(
        "--suite",
        default="verdicts",
        choices=["verdicts", "retrieval", "sql", "safety", "faithfulness", "criteria", "e2e", "all"],
    )
    ap.add_argument("--live", action="store_true")
    ap.add_argument("--limit", type=int, default=None)
    ap.add_argument("--persist", action="store_true", help="store runs in the database (eval_runs)")
    ap.add_argument("--fail-on-gate", action="store_true")
    args = ap.parse_args()

    from app.ai.evaluation.runner import run_suite

    suites = ["criteria", "safety", "verdicts", "faithfulness"] if args.suite == "all" else [args.suite]
    worst = 0
    for s in suites:
        out = asyncio.run(run_suite(s, live=args.live, limit=args.limit, persist=args.persist))
        print(
            json.dumps(
                {"suite": s, "status": out["status"], "gates": out["gates"], "report": out.get("report")},
                indent=2,
                default=str,
            )
        )
        if out["status"] != "passed":
            worst = 1
    return worst if args.fail_on_gate else 0


if __name__ == "__main__":
    raise SystemExit(main())
