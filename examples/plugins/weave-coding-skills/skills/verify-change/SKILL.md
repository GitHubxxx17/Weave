---
name: verify-change
description: Verify a coding change against observable requirements and report actual test and build evidence.
user-invocable: true
disable-model-invocation: false
metadata:
  author: Weave
---

Read the task's acceptance criteria and the repository's verification commands.
Map each meaningful behavior change to a check that could fail if it were wrong.
Use `references/verification-checklist.md` to choose proportionate checks.

Run the relevant tests, type checks, lint or build through available tools and
wait for the actual exit status. A command starting successfully is not evidence
that it passed. For a UI or integration change, exercise the real interaction or
boundary when the unit tests cannot establish the outcome.

When a check fails, inspect the failure and distinguish product behavior, test
expectations and environment limitations. Repair only work authorized by the
current task. Rerun the affected checks after a change, and complete repository
required gates before reporting success. Never invent a successful run or treat
an unavailable service as a passing check.

Report what changed, which checks passed, what remains unverified and any
material limitation. Cite actual evidence succinctly. This Skill grants no tool
permissions or authority to commit, push, publish, deploy or contact others.
