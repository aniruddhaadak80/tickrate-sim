---
name: product-overview
description: Use when someone new to Tickrate Sim needs to understand what it does and where its capabilities live, because the surface area is wider than one README can convey.
metadata:
  version: 1.0.0
---

# Tickrate Sim overview

## When to use this

You are orienting yourself in Tickrate Sim and need the map, not the detail.

## The one idea

Tickrate Sim compares two things that are normally kept apart: a **declaration** (the netcode
state machine you wrote down) and an **observation** (the transitions a server actually
performed, tick by tick). A violation is never "the trace is malformed". It is "reality did
something the declaration does not permit", and that is the only interesting question when
debugging a desync.

## Steps

1. `tickrate-sim doctor` - probes every subsystem, prints a fix hint per failing row.
2. `tickrate-sim tools --json` - the authoritative list of capabilities.
3. `tickrate-sim corpus list` - nine real traces and what each one demonstrates.
4. `tickrate-sim corpus show undeclared-skip` - the shortest complete walkthrough of the product.

## The five operations

| Operation        | Question                                         |
| ---------------- | ------------------------------------------------ |
| `validate_table` | Is the declaration coherent?                     |
| `replay`         | Where did reality outgrow the declaration?       |
| `tickrate_stats` | What rate did the server actually hit?           |
| `budget_profile` | Which tick budgets are tight, and which fiction? |
| `diff_tables`    | Which change would make a passing trace fail?    |

All five are pure Python functions, `mypy --strict` clean, reachable identically from the CLI,
from an MCP client, and from the web app.

## Where capability belongs

In order of preference. Adding to the core registry is the _last_ option, not the first:

1. Extend an existing tool
2. Add a CLI command plus a skill
3. Add a service-gated tool with a `check_fn`
4. Add a plugin
5. Add an MCP server tool to the catalog
6. Add a new core tool

## Verify

`tickrate-sim doctor` exits 0 and `tickrate-sim tools --json` lists seven tools.
