---
name: review-change
description: Review a proposed repository change for concrete correctness failures and missing verification.
user-invocable: true
disable-model-invocation: false
metadata:
  author: Your team
---

Read repository instructions and establish the requested change scope. Inspect
the relevant diff and surrounding contracts. Read references/review-checklist.md
when assessing findings. Verify a concrete trigger before reporting an issue.
Use only tools and permissions already granted for the task; this Skill grants
no additional execution, edit, publishing or installation authority.

Report actionable findings with location, impact and evidence. Distinguish an
actual failing behavior from an unverified concern. If the relevant files or
test runtime are unavailable, explain what could be reviewed and which check
remains for the user, without claiming tests ran.
