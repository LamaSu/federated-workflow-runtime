import type { FastifyInstance } from "fastify";
import type { DatabaseType } from "../db.js";
import { z } from "zod";

/**
 * GET /api/integrations
 *
 * The runtime doesn't track "installed integrations" as its own table — it
 * derives the list from what has actually been used (steps) or what has
 * patches/errors/credentials associated with it. That's good enough for a
 * dashboard and sidesteps the "does this file path exist" question entirely.
 *
 * Response: one row per integration name, with:
 *   - runCount   : number of steps that referenced this integration
 *   - errorCount : sum of error_signatures.occurrences for this integration
 *   - patchCount : rows in `patches` where integration matches
 *   - lastUsedAt : latest `steps.finished_at` for this integration
 */

export const IntegrationSummarySchema = z.object({
  name: z.string(),
  runCount: z.number().int(),
  errorCount: z.number().int(),
  patchCount: z.number().int(),
  credentialCount: z.number().int(),
  lastUsedAt: z.string().nullable(),
});

export type IntegrationSummary = z.infer<typeof IntegrationSummarySchema>;

interface StepIntegrationRow {
  integration: string;
  runs: number;
  last_used: string | null;
}

interface ErrorRow {
  integration: string;
  occurrences: number;
}

interface PatchRow {
  integration: string;
  c: number;
}

interface CredRow {
  integration: string;
  c: number;
}

/**
 * Integrations are inferred from step names: we store step names as-is in the
 * workflow definition (e.g., "http-generic:request" or just "slack-send"). The
 * workflow JSON is the source of truth for node.integration, so we parse it.
 *
 * But workflow JSON blobs live in the `definition` column. We could iterate
 * all workflows and parse them, but that's O(workflows) and adds JSON parsing
 * cost. For the MVP API we aggregate via what's already in flat columns:
 *   - error_signatures.integration (always recorded)
 *   - patches.integration          (always recorded)
 *   - credentials.integration      (always recorded)
 *   - steps.*                       (no integration column — computed via join
 *                                    to the workflow JSON would be expensive)
 *
 * We therefore surface a UNION of integrations that show up in ANY of those
 * three tables, with run counts drawn from the number of successful steps
 * whose runs reference a workflow using that integration name (computed via
 * a small JSON extraction). better-sqlite3 supports json_extract.
 */
export function registerIntegrationsRoutes(app: FastifyInstance, db: DatabaseType): void {
  app.get("/api/integrations", async () => {
    const errorRows = db
      .prepare(
        `SELECT integration, SUM(occurrences) AS occurrences
           FROM error_signatures
          GROUP BY integration`,
      )
      .all() as ErrorRow[];

    const patchRows = db
      .prepare(
        `SELECT integration, COUNT(*) AS c
           FROM patches
          GROUP BY integration`,
      )
      .all() as PatchRow[];

    const credRows = db
      .prepare(
        `SELECT integration, COUNT(*) AS c
           FROM credentials
          GROUP BY integration`,
      )
      .all() as CredRow[];

    // Run counts: parse each workflow definition once, count steps per
    // integration. Workflow definitions are small JSON blobs, so this is
    // inexpensive for the dashboard case.
    type DefinitionRow = { id: string; definition: string };
    const wfRows = db
      .prepare(`SELECT id, definition FROM workflows`)
      .all() as DefinitionRow[];

    const nodeIntegrations = new Map<string, string[]>(); // workflowId -> [integration]
    for (const w of wfRows) {
      try {
        const def = JSON.parse(w.definition) as {
          nodes?: Array<{ integration?: string }>;
        };
        const ints: string[] = [];
        for (const n of def.nodes ?? []) {
          if (typeof n.integration === "string") ints.push(n.integration);
        }
        nodeIntegrations.set(w.id, ints);
      } catch {
        nodeIntegrations.set(w.id, []);
      }
    }

    // Count runs per workflow.
    const runsPerWf = db
      .prepare(
        `SELECT workflow_id AS id, COUNT(*) AS c, MAX(finished_at) AS last
           FROM runs GROUP BY workflow_id`,
      )
      .all() as Array<{ id: string; c: number; last: string | null }>;

    const stepIntegrations: StepIntegrationRow[] = [];
    const perInt = new Map<string, { runs: number; last: string | null }>();
    for (const r of runsPerWf) {
      const ints = nodeIntegrations.get(r.id) ?? [];
      for (const i of ints) {
        const prev = perInt.get(i) ?? { runs: 0, last: null };
        prev.runs += r.c;
        if (r.last && (!prev.last || r.last > prev.last)) prev.last = r.last;
        perInt.set(i, prev);
      }
    }
    for (const [integration, v] of perInt) {
      stepIntegrations.push({ integration, runs: v.runs, last_used: v.last });
    }

    // Union of all integration names seen anywhere.
    const names = new Set<string>();
    for (const r of errorRows) names.add(r.integration);
    for (const r of patchRows) names.add(r.integration);
    for (const r of credRows) names.add(r.integration);
    for (const r of stepIntegrations) names.add(r.integration);

    const byName: Record<string, IntegrationSummary> = {};
    for (const name of names) {
      byName[name] = {
        name,
        runCount: 0,
        errorCount: 0,
        patchCount: 0,
        credentialCount: 0,
        lastUsedAt: null,
      };
    }
    for (const r of errorRows) byName[r.integration]!.errorCount = r.occurrences;
    for (const r of patchRows) byName[r.integration]!.patchCount = r.c;
    for (const r of credRows) byName[r.integration]!.credentialCount = r.c;
    for (const r of stepIntegrations) {
      byName[r.integration]!.runCount = r.runs;
      byName[r.integration]!.lastUsedAt = r.last_used;
    }

    const integrations = Object.values(byName)
      .map((i) => IntegrationSummarySchema.parse(i))
      .sort((a, b) => {
        // Most-recently-used first; then alphabetical by name as a tiebreaker.
        if (a.lastUsedAt && b.lastUsedAt) return a.lastUsedAt < b.lastUsedAt ? 1 : -1;
        if (a.lastUsedAt) return -1;
        if (b.lastUsedAt) return 1;
        return a.name.localeCompare(b.name);
      });
    return { integrations };
  });
}
