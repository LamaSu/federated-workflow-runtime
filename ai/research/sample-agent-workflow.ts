/**
 * Sample workflow demonstrating the `agent` step (integrations/agent).
 *
 * The agent's job: "summarize today's Linear bugs and post a digest to
 * #team on Slack." Instead of hardcoding the fetch → summarize → post
 * pipeline as three nodes, we give the agent a goal and a tool allowlist
 * of three integrations, and let it plan+execute the steps itself.
 *
 * Why this is different from the `chorus compose`-generated sample:
 *   - Compose generates a STATIC pipeline: nodes + edges decided at
 *     authoring time. Changing the goal means regenerating the workflow.
 *   - Agent is DYNAMIC: the LLM inspects the goal at runtime and picks
 *     tool calls on the fly. The same workflow template handles variations
 *     ("urgent bugs only," "include severity stats," "also post to #triage").
 *
 * Durability: the executor wraps the agent node in step.run, and the
 * planner wraps each iteration + each tool call in nested step.run
 * entries. A process crash mid-agent replays from the last memoized
 * iteration — no duplicate Slack posts, no redundant LLM spend.
 *
 * Usage: drop this in `chorus/daily-bug-digest-agent.ts`, set the
 * ANTHROPIC_API_KEY credential via `chorus credentials add`, and run
 * `chorus start` or `chorus run daily-bug-digest-agent`.
 */
import type { Workflow } from "@delightfulchorus/core";

const workflow: Workflow = {
  id: "daily-bug-digest-agent",
  name: "Daily Linear bug digest (agent-driven)",
  version: 1,
  active: true,
  trigger: {
    type: "cron",
    expression: "0 9 * * *",
    timezone: "UTC",
  },
  nodes: [
    {
      id: "digest-agent",
      integration: "agent",
      operation: "plan-and-execute",
      config: {
        // The model for PLANNING — tools inherit their own credentials.
        model: "claude-opus-4-7",
      },
      inputs: {
        goal: [
          "Summarize today's open Linear bugs in 3 bullet points, then post",
          "the summary to the #team channel on Slack. Include a count of",
          "bugs labeled 'urgent'. If there are no bugs, post a brief 'No",
          "bugs today' message.",
        ].join(" "),
        allowedIntegrations: ["http-generic", "llm-anthropic", "slack-send"],
        maxSteps: 12,
        context: {
          slackChannel: "#team",
          linearWorkspace: "chorus",
        },
      },
      retry: {
        maxAttempts: 2,
        backoffMs: 30_000,
        jitter: true,
      },
      onError: "retry",
    },
  ],
  connections: [],
  createdAt: "2026-04-22T09:00:00Z",
  updatedAt: "2026-04-22T09:00:00Z",
};

export default workflow;

/*
Execution trace (illustrative — actual step counts vary with the LLM):

  Iteration 0: LLM thinks "I need to fetch Linear bugs first."
               Tool call: http-generic.request with a GraphQL query.
               Observation: { body: { data: { issues: { nodes: [...] } } } }

  Iteration 1: LLM thinks "I have the raw data — now summarize it."
               Tool call: llm-anthropic.generate with the issues rendered
               into a prompt + instructions to produce 3 bullets.
               Observation: { text: "- bug A\n- bug B\n- bug C", usage: {...} }

  Iteration 2: LLM thinks "Count urgent bugs, append the count."
               (In-head reasoning — no tool call.)
               Actually: LLM re-emits a tool call OR folds the count into
               its next answer synthesis.

  Iteration 3: LLM thinks "Post to Slack."
               Tool call: slack-send.postMessage with channel + text.
               Observation: { ok: true, ts: "1234567890.123" }

  Iteration 4: LLM emits finalAnswer: "Posted digest to #team with 3 bugs, 1 urgent."
               success=true, loop exits.

Total: 4 LLM calls, 3 tool calls, ~8k prompt tokens, ~1k completion tokens.
If the run crashes between iterations, the next run replays from the cached
step outputs — no duplicate Linear queries, no duplicate Slack posts.
*/
