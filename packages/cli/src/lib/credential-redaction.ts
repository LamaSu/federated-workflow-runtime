/**
 * Credential redaction for chorus share / chorus import.
 *
 * Walks a workflow graph and replaces any field that an integration's
 * CredentialTypeDefinition marks as `type: "password"` with a
 * `__credentialRef` stub. Non-sensitive config is preserved verbatim.
 *
 * See docs/CLOUD_DISTRIBUTION.md §5.3 for the contract.
 *
 * Design notes:
 * - Pure function. No I/O. No network. No DB. Unit-testable in isolation.
 * - Works on the plain Workflow shape from @delightfulchorus/core — does
 *   NOT require the workflow to come from a running runtime.
 * - Catalog lookups are keyed by integration *name* (the same string
 *   used on `Node.integration`). Callers supply the per-integration
 *   catalog as a plain map, so this module has no direct dependency on
 *   the integration loader.
 * - The stub format is stable: `{ __credentialRef: true, credentialType,
 *   fieldName, hint }`. The shape is documented in the public JSON
 *   schema used by `chorus import` for round-trip validation.
 */
import type {
  CredentialTypeDefinition,
  Workflow,
  Node as WorkflowNode,
} from "@delightfulchorus/core";

/** Map from integration name (e.g. "slack-send") → declared credential types. */
export type IntegrationCatalogs = Record<string, readonly CredentialTypeDefinition[]>;

/** The stub we substitute for a redacted credential value. */
export interface CredentialRef {
  readonly __credentialRef: true;
  /** The integration this credential type lives on (e.g. "slack-send"). */
  readonly integration: string;
  /**
   * The credential type name (the `name` field on the
   * CredentialTypeDefinition). Importing side looks up a credential of
   * this type to rebind.
   */
  readonly credentialType: string;
  /** The field name inside the credential (e.g. "accessToken"). */
  readonly fieldName: string;
  /** Human-readable hint shown when the importer is missing credentials. */
  readonly hint: string;
}

/**
 * A workflow whose sensitive credential fields have been stubbed out.
 * Structurally identical to Workflow except that Node.config may contain
 * CredentialRef objects in place of the original string values.
 */
export type RedactedWorkflow = Omit<Workflow, "nodes"> & {
  nodes: readonly RedactedNode[];
};

export type RedactedNode = Omit<WorkflowNode, "config"> & {
  config: Record<string, unknown>;
};

/**
 * Type guard for CredentialRef objects in a (potentially round-tripped)
 * workflow. Importers use this to find the stubs to rebind.
 */
export function isCredentialRef(value: unknown): value is CredentialRef {
  if (!value || typeof value !== "object") return false;
  const v = value as Partial<CredentialRef>;
  return (
    v.__credentialRef === true &&
    typeof v.integration === "string" &&
    typeof v.credentialType === "string" &&
    typeof v.fieldName === "string"
  );
}

/**
 * Strip sensitive credential material from a workflow.
 *
 * For each node, we look up the integration's credential catalog. For
 * every CredentialTypeDefinition the integration declares, we enumerate
 * its fields; any field whose `type === "password"` is scrubbed from
 * `node.config`.
 *
 * Fields that aren't marked password (e.g. `workspaceUrl`, `clientId`)
 * are preserved — they're not secrets and are needed to reconstruct the
 * runnable workflow on import.
 *
 * Integrations without a catalog entry are handled conservatively:
 * there's no way to know which fields are sensitive, so we strip any
 * node.config key that matches a heuristic list of secret-looking names
 * (apiKey, token, secret, password, etc.). This is a fallback and is
 * logged in `fallbackStrippedKeys` on the result for caller visibility.
 */
export interface RedactResult {
  workflow: RedactedWorkflow;
  /** Per-node: which config keys were replaced with CredentialRef stubs. */
  stubbed: Array<{ nodeId: string; fieldName: string; credentialType: string }>;
  /**
   * Per-node: which config keys were stripped via heuristic fallback
   * (integration has no catalog entry). Populated only when heuristic
   * fires.
   */
  fallbackStrippedKeys: Array<{ nodeId: string; key: string }>;
}

export function redactCredentials(
  workflow: Workflow,
  catalogs: IntegrationCatalogs,
): RedactResult {
  const stubbed: RedactResult["stubbed"] = [];
  const fallbackStrippedKeys: RedactResult["fallbackStrippedKeys"] = [];

  const nodes: RedactedNode[] = workflow.nodes.map((node) => {
    const catalog = catalogs[node.integration];
    const newConfig: Record<string, unknown> = { ...node.config };

    if (catalog && catalog.length > 0) {
      // Catalog-aware path: strip fields the catalog says are passwords.
      const passwordFields = collectPasswordFields(catalog);
      for (const { fieldName, credentialType } of passwordFields) {
        if (!(fieldName in newConfig)) continue;
        const hint = buildHint({
          integration: node.integration,
          credentialType,
        });
        newConfig[fieldName] = {
          __credentialRef: true,
          integration: node.integration,
          credentialType,
          fieldName,
          hint,
        } satisfies CredentialRef;
        stubbed.push({ nodeId: node.id, fieldName, credentialType });
      }
    } else {
      // Fallback path: integration's catalog is unavailable. Best we
      // can do is scan config keys by name and strip any that *look*
      // like secrets. Never perfect — document in the result so the
      // caller can surface a warning.
      for (const key of Object.keys(newConfig)) {
        if (looksLikeSecret(key)) {
          const hint = buildHint({
            integration: node.integration,
            credentialType: "unknown",
          });
          newConfig[key] = {
            __credentialRef: true,
            integration: node.integration,
            credentialType: "unknown",
            fieldName: key,
            hint,
          } satisfies CredentialRef;
          fallbackStrippedKeys.push({ nodeId: node.id, key });
        }
      }
    }

    return {
      ...node,
      config: newConfig,
    };
  });

  const redacted: RedactedWorkflow = {
    ...workflow,
    nodes,
  };

  return {
    workflow: redacted,
    stubbed,
    fallbackStrippedKeys,
  };
}

// ── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Walk an integration's credential catalog and return every field that
 * an importer would have to prompt the user for a new value of.
 * Covers `type === "password"`. Could be widened to other sensitive
 * types later (e.g. a new `"secret"` literal) without breaking the
 * public shape of the transform.
 */
function collectPasswordFields(
  catalog: readonly CredentialTypeDefinition[],
): Array<{ fieldName: string; credentialType: string }> {
  const out: Array<{ fieldName: string; credentialType: string }> = [];
  for (const ct of catalog) {
    for (const f of ct.fields) {
      if (f.type === "password") {
        out.push({ fieldName: f.name, credentialType: ct.name });
      }
    }
  }
  return out;
}

/**
 * Heuristic check for unknown-catalog cases. Matches common secret
 * field names case-insensitively. Deliberately conservative — this
 * catches "apiKey", "API_KEY", "token", "accessToken", "secret",
 * "password", "privateKey", "client_secret", but NOT "url",
 * "workspace", "channel". A false positive (a safe field we mistakenly
 * strip) is recoverable via rebinding. A false negative (a secret we
 * leave in) is a credential leak. So: be strict.
 */
function looksLikeSecret(key: string): boolean {
  const lowered = key.toLowerCase();
  const needles = [
    "password",
    "secret",
    "token",
    "apikey",
    "api_key",
    "privatekey",
    "private_key",
    "client_secret",
    "accesstoken",
    "access_token",
    "refreshtoken",
    "refresh_token",
    "bearer",
    "credential",
  ];
  return needles.some((n) => lowered.includes(n));
}

function buildHint(args: {
  integration: string;
  credentialType: string;
}): string {
  return (
    `Rebind on import: run \`chorus credentials add ${args.integration}\` ` +
    `and link the resulting credential to this reference.`
  );
}

/**
 * Count references for progress reporting. Used by `chorus import` to
 * tell the user "n credential references need rebinding."
 */
export function countCredentialRefs(workflow: RedactedWorkflow): number {
  let n = 0;
  for (const node of workflow.nodes) {
    for (const v of Object.values(node.config)) {
      if (isCredentialRef(v)) n++;
    }
  }
  return n;
}

/**
 * Collect all CredentialRef stubs from a redacted workflow, grouped by
 * integration. The import flow walks this to tell the user "you need a
 * slack-send:<anyName> and a stripe:<anyName> before this will run."
 */
export interface RefBucket {
  integration: string;
  credentialType: string;
  /** Every (nodeId, fieldName) pair that points at this credential type. */
  sites: Array<{ nodeId: string; fieldName: string }>;
}

export function gatherCredentialRefs(
  workflow: RedactedWorkflow,
): RefBucket[] {
  const buckets = new Map<string, RefBucket>();
  for (const node of workflow.nodes) {
    for (const [fieldName, value] of Object.entries(node.config)) {
      if (!isCredentialRef(value)) continue;
      const key = `${value.integration}::${value.credentialType}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        bucket = {
          integration: value.integration,
          credentialType: value.credentialType,
          sites: [],
        };
        buckets.set(key, bucket);
      }
      bucket.sites.push({ nodeId: node.id, fieldName });
    }
  }
  return [...buckets.values()];
}
