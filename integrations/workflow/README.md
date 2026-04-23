# @delightfulchorus/integration-workflow

Subgraph composition for Chorus workflows. A node whose `integration` is
`"workflow"` invokes another local Chorus workflow as a single memoized step.

With this primitive, supervisor / hierarchical / network multi-agent patterns
become compositions of existing chorus parts — no separate scaffolds needed.

## Install

```bash
npm install @delightfulchorus/integration-workflow
```

The integration auto-registers when the runtime discovers `integration:
"workflow"` nodes. The runtime also wires a default `SubgraphRunner` that
resolves child workflows from the same SQLite DB the parent uses — there's no
extra configuration.

## Node shape

```yaml
- id: transcribe-then-summarize
  integration: workflow
  operation: invoke
  config:
    workflowId: summarize-text@2  # required
    inputMapping:                  # optional
      text: triggerPayload.body
  inputs:
    sourceText: "..."
```

Or the IIP-friendly form (recommended for FBP-friendly workflows):

```yaml
- id: transcribe-then-summarize
  integration: workflow
  operation: invoke
  inputs:
    workflowId: summarize-text@2
    sourceText: "..."
```

The handler accepts `workflowId` and `inputMapping` from EITHER `node.inputs`
or `node.config`. Inputs win when both are present.

## Behavior

1. Resolve the child workflow by id (with optional `@version` suffix).
2. Apply the optional `inputMapping` to derive the child's trigger payload.
3. Spawn a child run synchronously — same DB, same Executor, fresh runId.
4. Wait for the child to complete.
5. Return the child's terminal output (the output of its last node).

The whole subgraph runs as ONE memoized step in the parent. On replay, the
parent's `step.run` short-circuits to the cached output without re-invoking
the child.

## Recursion

Child workflows can themselves contain `integration: "workflow"` nodes. The
runtime propagates the `SubgraphRunner` to every level — recursion works
out of the box. There are no built-in depth limits in MVP; cycles will
stack-overflow.

## Inspecting child runs

The handler returns `{ output, childRunId, workflowId }`. You can inspect a
child run independently using the standard tooling:

```bash
chorus run history <child-runId>
```

Children are also visible in the runs table with `triggered_by = 'subgraph'`.

## inputMapping syntax

`inputMapping` is a `Record<string, string>` where:

- The KEY is a dot-path in the child's trigger payload (where the value
  lands).
- The VALUE is a dot-path in the parent's input record (where the value
  comes from). The parent's input is `{ ...node.inputs, triggerPayload }`,
  so paths can reach into either source.

Path syntax: dot-segmented + optional `[N]` array indices. Examples:

```yaml
inputMapping:
  greeting: triggerPayload.message
  user.id: userId
  items[0].sku: products[0].sku
```

With NO mapping, the child receives the parent's input verbatim (minus the
handler's own bookkeeping fields: `workflowId` and `inputMapping`).

## Memoization invariant

- Parent's `steps` table: ONE row for the subgraph node, output = child's
  terminal output (JSON-encoded).
- Child has its own `runId` + its own `steps` rows in the same SQLite DB.
- Parent replay: subgraph node returns memoized output without re-creating
  the child run.

This is the same Inngest-replay model the rest of Chorus uses — see
`packages/runtime/src/executor.ts`.

## FBP round-trip

`integration: "workflow"` nodes round-trip through the
`@delightfulchorus/fbp` adapter to NoFlo `.fbp` text format and back, with
two caveats:

1. Use the IIP form (`inputs.workflowId`) — config keys don't survive the
   round-trip.
2. The FBP adapter lowercases port names. The handler is case-insensitive
   on `workflowId` / `inputMapping` keys, so this is functionally lossless;
   the literal key string changes.
3. `inputMapping` objects come back as JSON strings (FBP serializes complex
   values as quoted JSON). The handler JSON-parses string-typed
   `inputMapping` values automatically.

## Status of partial features

- Cross-instance subgraphs (invoke a workflow on a different chorus node) —
  **not supported**; planned for wave 3 (worknet).
- Streaming intermediate output from the child to the parent — **not
  supported**; planned for wave 4.
- Suspending the parent on a child's `step.askUser` — **not supported**;
  the child's suspension surfaces as an error to the parent in MVP.
