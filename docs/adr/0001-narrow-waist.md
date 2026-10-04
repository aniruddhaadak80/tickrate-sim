# 0001 - The narrow waist is one tool registry

## Status

Accepted.

## Context

This product has five capabilities and four ways to reach them: a CLI, a web app, an MCP server
for other agents, and a JSON API. The tempting shape is for each transport to grow its own idea
of what a "replay" is - a `replay` function in the CLI, a route handler that re-implements the
walk for the browser, an MCP tool with its own argument parsing.

That shape is how a tool starts disagreeing with itself. The web page says a trace is legal; the
CLI says it has three violations; nobody can say which one is lying, and the answer is usually
that both are.

## Decision

Every capability is a `Tool` in `packages/core`. One registry. One interface. One place where a
duplicate name is refused. The CLI, the web API and the MCP server are transports: they resolve
a name in the registry, validate input against the tool's declared schema, and return whatever
the handler returned.

Concretely, this means:

- `tickrate-sim replay` and the MCP tool `replay_trace` execute the same handler.
- The MCP tool list is _derived_ from the registry (`describeTools`), not maintained beside it,
  so a tool cannot be added to one and forgotten in the other.
- A tool declares the permissions it needs, and the registry refuses before the handler runs
  rather than catching afterwards.
- Input is validated at the boundary, always, before any work happens.

## Consequences

- Adding a capability means adding one tool, not one implementation per surface.
- The web app is the interesting case, because it cannot reach the Python engine. That
  constraint is handled by _proving_ equivalence rather than by forking the logic - see
  [0003 - The browser mirror is proven, not trusted](./0003-browser-mirror-parity.md).
- The cost is that a genuinely different interaction sometimes wants to reshape a result. That
  reshaping belongs in the presentation layer, not in the handler, or it becomes a second
  implementation wearing a different name.
