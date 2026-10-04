---
name: diagnose
description: Use when Tickrate Sim is misbehaving and the cause is not obvious, because the diagnostic order below finds the failing subsystem without guesswork.
metadata:
  version: 1.0.0
---

# Diagnose Tickrate Sim

## When to use this

Something is broken and you do not yet know which subsystem is at fault.

## Steps

1. `tickrate-sim doctor` - read the failing row and its **fix** line. Do not skip to step 2.
   The `engine` row genuinely spawns Python and calls it, so a passing engine row is evidence.
2. If `skills` is failing: `tickrate-sim tools --json` and look at the `issues` array from
   `list_skills`. Fix the file, do not delete the skill.
3. If `plugins` is warning: the `list_plugins` tool reports each rejection with its reason. A
   version mismatch names the required and running ranges.
4. If one capability misbehaves: `tickrate-sim tools --json` to confirm it is registered, then
   `tickrate-sim mcp call <tool> '{}'` to see the error envelope with its stable code.
5. If the corpus is failing: `python services/engine/scripts/sync_cases.py` regenerates it. The
   fix line says so.
6. If the web app is stale: `curl -s localhost:3000/api/health` and read `checks`. Note that the
   `engine` row there is `warn` by design - a serverless function cannot spawn Python, and
   reporting an engine probe it did not run would be worse than admitting it.

## Error codes

| Code                | Meaning                               | First move                               |
| ------------------- | ------------------------------------- | ---------------------------------------- |
| `VALIDATION_FAILED` | input did not match the tool's schema | the message names the exact field path   |
| `PERMISSION_DENIED` | tool needs a permission not granted   | check the declared permissions           |
| `CONFLICT`          | duplicate name at registration        | find the other registrant                |
| `NOT_FOUND`         | no such case, skill or table          | check the id spelling                    |
| `UPSTREAM_FAILED`   | the Python engine returned an error   | run the op directly, read `durationMs`   |
| `TIMEOUT`           | the engine did not answer in time     | raise the timeout or make the op cheaper |

## Verify

`tickrate-sim doctor` exits 0.
