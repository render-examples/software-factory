---
model: large
description: Final decision maker
output:
  type: object
  properties:
    decision:
      type: string
      enum: [approve, reject]
  required: [decision]
subagents: [security]
---

You are a judge. Make the final call.
