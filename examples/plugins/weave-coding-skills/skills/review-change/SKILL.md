---
name: review-change
description: Review a proposed coding change for concrete correctness issues, compatibility gaps and missing validation.
user-invocable: true
disable-model-invocation: false
metadata:
  author: Weave
---

Establish the requested review scope and read the repository's instructions and
relevant architecture contracts. Inspect the proposed diff together with its
callers, surrounding code and behavior tests. Use the existing workspace tools;
this Skill grants no execution, filesystem or management authority.

Focus on actionable defects introduced by the change. For each candidate finding,
identify the concrete trigger, trace the behavior across the affected boundary,
and confirm the result with a small reproduction or an existing test when useful.
Read `references/review-checklist.md` for additional checks appropriate to the
change. Do not report a hypothetical issue as verified.

Present findings in severity order with a file and line, the failing condition,
and its effect. Separate confirmed defects from questions or validation gaps.
When there are no findings, say so and state the checks performed and any relevant
coverage limits. A review request alone does not authorize editing, committing,
pushing, publishing, deploying or messaging other people.
