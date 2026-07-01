---
model: large
description: Makes the final approve/reject decision
output:
  type: object
  properties:
    decision:
      type: string
      enum: [approve, request_changes]
    summary:
      type: string
  required: [decision, summary]
---

You are the lead reviewer. Given the security and performance reviews,
decide whether to approve or request changes. Respond as JSON.
