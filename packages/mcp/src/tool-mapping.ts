/**
 * @chorus/mcp — tool-mapping
 *
 * Pure functions that transform a Chorus IntegrationManifest into an array
 * of MCP tool descriptors. No side effects, no I/O, no MCP SDK types — just
 * the shape that the server module wraps with the SDK.
 *
 * The mapping is the "what tools does this integration expose?" answer. It
 * does NOT execute anything; that's server.ts's job.
 *
 * Shape follows the MCP 2024-11-05 spec for tools:
 *   { name, description, inputSchema: JSONSchema }
 *
 * Credential tool contract per docs/CREDENTIALS_ANALYSIS.md §7:
 *   <integration>__list_credentials          — always, read-only
 *   <integration>__configure_<typeName>      — one per credentialType
 *   <integration>__authenticate              — OAuth types only (at integration level;
 *                                              takes typeName as input when >1 OAuth type)
 *   <integration>__test_auth                 — always
 *
 * Operation tools: `<integration>__<operation>` with input schema from the
 * operation's `inputSchema` (which, per core/schemas.ts line 96, is already a
 * plain JSONSchema `z.record(z.unknown())` — we pass it through, no Zod
 * conversion needed).
 */
import type { IntegrationManifest, OperationDefinition } from "@chorus/core";

// ── MCP tool shape ──────────────────────────────────────────────────────────

/**
 * A single MCP tool descriptor. Matches the shape returned by MCP's
 * `tools/list` response. We keep this minimal + SDK-agnostic so tool-mapping
 * stays testable without the @modelcontextprotocol/sdk peer dep.
 */
export interface McpTool {
  /** Fully-qualified tool name: `<integration>__<operation-or-credential-verb>`. */
  name: string;
  /** Human-readable description. Surfaces in MCP clients (Claude Desktop, Cursor). */
  description: string;
  /**
   * JSON Schema draft 2020-12 shape (MCP's convention). For Chorus operations
   * this is the operation's declared inputSchema (already JSONSchema-shaped).
   */
  inputSchema: JsonSchemaObject;
  /**
   * Back-pointer into the integration so server.ts can dispatch. Kept
   * optional because generator scaffolds serialize the tool without it —
   * the runtime fills it in at dispatch time.
   */
  _chorus?: ChorusToolBinding;
}

export type JsonSchemaObject = Record<string, unknown>;

/**
 * Internal binding: tells the MCP server how to execute a tool call.
 * `kind` narrows between integration operations and credential-control tools;
 * downstream dispatch logic in server.ts switches on it.
 */
export type ChorusToolBinding =
  | { kind: "operation"; integration: string; operation: string }
  | { kind: "credential"; integration: string; verb: CredentialVerb; credentialTypeName?: string };

export type CredentialVerb = "list_credentials" | "configure" | "authenticate" | "test_auth";

// ── Credential type shape (duck-typed) ──────────────────────────────────────

/**
 * Duck-typed view of a CredentialTypeDefinition. credentials-oscar owns the
 * canonical Zod schema; this interface is the subset tool-mapping needs.
 *
 * When credentials-oscar ships `CredentialTypeDefinition` in `@chorus/core`,
 * this shape is a compatible upcast — we can drop to importing theirs by
 * swapping the import, no handler changes.
 */
export interface CredentialTypeView {
  name: string;
  displayName: string;
  authType: "none" | "apiKey" | "oauth2" | "basic" | "bearer";
  fields?: CredentialFieldView[];
  description?: string;
  documentationUrl?: string;
}

export interface CredentialFieldView {
  name: string;
  displayName: string;
  type: "string" | "password" | "url" | "number" | "boolean" | "select";
  required?: boolean;
  description?: string;
  deepLink?: string;
  default?: string | number | boolean;
  options?: Array<{ value: string; label: string }>;
  oauthManaged?: boolean;
}

/**
 * Duck-typed view of a manifest that MAY have `credentialTypes`. When
 * credentials-oscar extends IntegrationManifestSchema with `credentialTypes`,
 * this cast becomes load-bearing; until then, we synthesize a legacy type
 * from `authType`.
 */
export interface ManifestWithCredentialTypes extends IntegrationManifest {
  credentialTypes?: CredentialTypeView[];
}

// ── Operation → tool ────────────────────────────────────────────────────────

/**
 * Turn a single operation into an MCP tool. The tool name is
 * `<integration>__<operation>` (double underscore prevents collisions with
 * Slack-style operation names that contain a single underscore).
 *
 * Per docs §7 the description is built from `opDef.description`, with a
 * footer linking to the integration's docsUrl when present.
 */
export function operationToMcpTool(
  integration: ManifestWithCredentialTypes,
  opDef: OperationDefinition,
): McpTool {
  const name = `${integration.name}__${opDef.name}`;
  const desc = buildOperationDescription(integration, opDef);
  return {
    name,
    description: desc,
    inputSchema: sanitizeJsonSchema(opDef.inputSchema),
    _chorus: {
      kind: "operation",
      integration: integration.name,
      operation: opDef.name,
    },
  };
}

function buildOperationDescription(
  integration: IntegrationManifest,
  opDef: OperationDefinition,
): string {
  const parts = [opDef.description.trim()];
  if (opDef.idempotent) parts.push("(idempotent)");
  if (integration.docsUrl) parts.push(`\nDocs: ${integration.docsUrl}`);
  return parts.join(" ").trim();
}

/**
 * Ensure the inputSchema we return is a shape MCP clients recognize. Chorus
 * integrations store input schemas as JSON-schema objects already; we
 * normalize minimally: guarantee top-level `type: "object"` when absent, so
 * every tool has a predictable schema root (MCP clients like Claude Desktop
 * refuse tools without an object root).
 */
function sanitizeJsonSchema(raw: Record<string, unknown>): JsonSchemaObject {
  if (!raw || typeof raw !== "object") {
    return { type: "object", properties: {}, additionalProperties: false };
  }
  const clone: JsonSchemaObject = { ...raw };
  if (clone.type === undefined) clone.type = "object";
  if (clone.type === "object" && clone.properties === undefined) {
    clone.properties = {};
  }
  return clone;
}

// ── Credential type → tools (per docs/CREDENTIALS_ANALYSIS.md §7) ───────────

/**
 * Generate the credential-control tools for a single credential type. Per
 * design §7 each credential type emits:
 *   - `<integration>__configure_<typeName>` — always
 *   - OAuth types additionally contribute to the shared `__authenticate` tool
 *     (handled in `manifestToMcpTools`, not here).
 *
 * `__list_credentials` and `__test_auth` are once per integration, not once
 * per type — also emitted by `manifestToMcpTools`.
 */
export function credentialTypeToMcpTools(
  integration: ManifestWithCredentialTypes,
  credType: CredentialTypeView,
): McpTool[] {
  return [buildConfigureTool(integration, credType)];
}

function buildConfigureTool(
  integration: ManifestWithCredentialTypes,
  credType: CredentialTypeView,
): McpTool {
  const name = `${integration.name}__configure_${credType.name}`;
  const descParts: string[] = [
    `Configure a ${credType.displayName} credential for ${integration.name}.`,
  ];
  if (credType.description) descParts.push(credType.description);
  if (credType.documentationUrl) {
    descParts.push(`\nDocs: ${credType.documentationUrl}`);
  }

  const properties: Record<string, JsonSchemaObject> = {
    name: {
      type: "string",
      description: "Label for this credential (e.g. 'work', 'personal'). Defaults to 'default'.",
      default: "default",
    },
  };
  const required: string[] = [];

  // Skip OAuth-managed fields — those are populated by the authorize flow,
  // not by the caller. Per docs §7.2 "Input schema = JSON-schema of the
  // type's `fields[]` minus `oauthManaged`".
  const fields = (credType.fields ?? []).filter((f) => !f.oauthManaged);
  for (const field of fields) {
    properties[field.name] = fieldToJsonSchemaProperty(field);
    if (field.required !== false) required.push(field.name);
  }

  const inputSchema: JsonSchemaObject = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) inputSchema.required = required;

  return {
    name,
    description: descParts.join(" "),
    inputSchema,
    _chorus: {
      kind: "credential",
      integration: integration.name,
      verb: "configure",
      credentialTypeName: credType.name,
    },
  };
}

function fieldToJsonSchemaProperty(field: CredentialFieldView): JsonSchemaObject {
  const descParts: string[] = [];
  if (field.description) descParts.push(field.description);
  if (field.deepLink) descParts.push(`Get this value at: ${field.deepLink}`);
  const description = descParts.join(" ").trim() || field.displayName;

  const base: JsonSchemaObject = { description };

  switch (field.type) {
    case "string":
      return { ...base, type: "string" };
    case "password":
      // JSON-schema has no canonical "password" — we signal it with `format`
      // and `writeOnly` so MCP clients that honor those hints mask input.
      return { ...base, type: "string", format: "password", writeOnly: true };
    case "url":
      return { ...base, type: "string", format: "uri" };
    case "number":
      return { ...base, type: "number" };
    case "boolean":
      return { ...base, type: "boolean" };
    case "select":
      return {
        ...base,
        type: "string",
        enum: (field.options ?? []).map((o) => o.value),
      };
    default:
      return { ...base, type: "string" };
  }
}

// ── Integration-level shared credential tools ───────────────────────────────

/**
 * `__list_credentials` — one per integration. Read-only; input is empty object.
 * Output shape (per §7.2 "returns [{id, name, credentialTypeName, authType, state}]")
 * is asserted by the server at runtime; MCP's `inputSchema` is what we declare here.
 */
function buildListCredentialsTool(integration: ManifestWithCredentialTypes): McpTool {
  return {
    name: `${integration.name}__list_credentials`,
    description:
      `List credentials stored for ${integration.name}. ` +
      `Returns id, name, credentialTypeName, authType, and state for each. ` +
      `No secrets are returned.`,
    inputSchema: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    _chorus: {
      kind: "credential",
      integration: integration.name,
      verb: "list_credentials",
    },
  };
}

/**
 * `__authenticate` — OAuth-only. Starts the OAuth 2.0 authorize-code flow.
 * Input takes the credentialTypeName (required when >1 OAuth type is declared;
 * optional when exactly one). Returns `{authorizeUrl, credentialId}`.
 */
function buildAuthenticateTool(
  integration: ManifestWithCredentialTypes,
  oauthTypes: CredentialTypeView[],
): McpTool {
  const properties: Record<string, JsonSchemaObject> = {
    name: {
      type: "string",
      description: "Label for this credential (e.g. 'work', 'personal'). Defaults to 'default'.",
      default: "default",
    },
  };
  const required: string[] = [];
  if (oauthTypes.length > 1) {
    properties.credentialTypeName = {
      type: "string",
      description:
        "Which OAuth credential type to authenticate. Required because this integration declares multiple OAuth types.",
      enum: oauthTypes.map((t) => t.name),
    };
    required.push("credentialTypeName");
  }

  const descParts = [
    `Start the OAuth 2.0 authorize flow for ${integration.name}.`,
    `Returns an authorizeUrl to open in a browser; the Chorus runtime receives the callback and stores the credential.`,
  ];
  if (oauthTypes.length === 1 && oauthTypes[0]?.documentationUrl) {
    descParts.push(`\nDocs: ${oauthTypes[0].documentationUrl}`);
  }

  const inputSchema: JsonSchemaObject = {
    type: "object",
    properties,
    additionalProperties: false,
  };
  if (required.length > 0) inputSchema.required = required;

  return {
    name: `${integration.name}__authenticate`,
    description: descParts.join(" "),
    inputSchema,
    _chorus: {
      kind: "credential",
      integration: integration.name,
      verb: "authenticate",
    },
  };
}

/**
 * `__test_auth` — one per integration. Runs the test hook per §4.4 resolution
 * precedence (test.viaOperation → testCredential() → "no test" error).
 */
function buildTestAuthTool(integration: ManifestWithCredentialTypes): McpTool {
  return {
    name: `${integration.name}__test_auth`,
    description:
      `Test whether a stored credential for ${integration.name} still works. ` +
      `Runs the integration's test hook (read-only; never mutates external state). ` +
      `Returns ok/latencyMs/identity/error.`,
    inputSchema: {
      type: "object",
      properties: {
        credentialId: {
          type: "string",
          description: "ID of the credential to test. Get this from __list_credentials.",
        },
      },
      required: ["credentialId"],
      additionalProperties: false,
    },
    _chorus: {
      kind: "credential",
      integration: integration.name,
      verb: "test_auth",
    },
  };
}

// ── Full manifest → tool array ──────────────────────────────────────────────

/**
 * Map a full integration manifest to the complete MCP tool set:
 *   - one tool per operation
 *   - plus the 4 credential-control tools per §7 when credentialTypes are declared
 *
 * When the manifest predates credentials-oscar's upgrade (no `credentialTypes`),
 * we synthesize a single "legacy" credential type from `authType` so tools are
 * still exposed for clients that want to configure the credential.
 */
export function manifestToMcpTools(manifest: ManifestWithCredentialTypes): McpTool[] {
  const tools: McpTool[] = [];

  // Operations first — these are the useful-work tools agents care about.
  for (const op of manifest.operations) {
    tools.push(operationToMcpTool(manifest, op));
  }

  // Credential tools — only when the integration actually needs credentials.
  const credentialTypes = resolveCredentialTypes(manifest);
  if (credentialTypes.length === 0) return tools;

  // Shared per-integration tools.
  tools.push(buildListCredentialsTool(manifest));

  // Per-type configure tools.
  for (const ct of credentialTypes) {
    tools.push(...credentialTypeToMcpTools(manifest, ct));
  }

  // OAuth authenticate tool, if any OAuth types are declared.
  const oauthTypes = credentialTypes.filter((ct) => ct.authType === "oauth2");
  if (oauthTypes.length > 0) {
    tools.push(buildAuthenticateTool(manifest, oauthTypes));
  }

  // Test-auth is always emitted when we have any credential type.
  tools.push(buildTestAuthTool(manifest));

  return tools;
}

/**
 * Pick the credential types to expose. Precedence:
 *   1. If the manifest has a non-empty `credentialTypes` array, use it as-is.
 *   2. Else if `authType !== "none"`, synthesize a legacy type so MCP clients
 *      can still configure credentials for pre-upgrade integrations.
 *   3. Else return [] (no credential tools exposed).
 *
 * The synthesized legacy type uses field name `secret` (for apiKey/bearer)
 * or `{username, password}` (for basic) — matching the shapes described in
 * the existing `extractBearerToken` helper in slack-send/src/index.ts.
 */
export function resolveCredentialTypes(
  manifest: ManifestWithCredentialTypes,
): CredentialTypeView[] {
  if (manifest.credentialTypes && manifest.credentialTypes.length > 0) {
    return manifest.credentialTypes;
  }
  if (manifest.authType === "none") return [];
  return [synthesizeLegacyCredentialType(manifest)];
}

function synthesizeLegacyCredentialType(
  manifest: IntegrationManifest,
): CredentialTypeView {
  const authType = manifest.authType;
  const baseName = `${manifest.name}Legacy`;
  const displayName = `${manifest.name} (legacy ${authType})`;
  const docs = manifest.docsUrl;

  switch (authType) {
    case "apiKey":
    case "bearer":
      return {
        name: baseName,
        displayName,
        authType,
        description:
          `Legacy ${authType} credential for ${manifest.name}. Integration has not yet migrated to credentialTypes[]; update the manifest for richer tooling.`,
        documentationUrl: docs,
        fields: [
          {
            name: "secret",
            displayName: authType === "apiKey" ? "API Key" : "Bearer Token",
            type: "password",
            required: true,
            description: `The ${authType} secret. Stored encrypted with CHORUS_ENCRYPTION_KEY.`,
          },
        ],
      };
    case "basic":
      return {
        name: baseName,
        displayName,
        authType,
        description: `Legacy basic-auth credential for ${manifest.name}.`,
        documentationUrl: docs,
        fields: [
          {
            name: "username",
            displayName: "Username",
            type: "string",
            required: true,
          },
          {
            name: "password",
            displayName: "Password",
            type: "password",
            required: true,
          },
        ],
      };
    case "oauth2":
      return {
        name: baseName,
        displayName,
        authType,
        description:
          `Legacy OAuth2 credential for ${manifest.name}. Manifest lacks oauth flow metadata — __authenticate will error until credentialTypes[] is declared.`,
        documentationUrl: docs,
        fields: [
          {
            name: "accessToken",
            displayName: "Access Token",
            type: "password",
            required: true,
            oauthManaged: true,
          },
          {
            name: "refreshToken",
            displayName: "Refresh Token",
            type: "password",
            required: false,
            oauthManaged: true,
          },
        ],
      };
    case "none":
      // Unreachable (caller filters none). Included for total-coverage type checking.
      return {
        name: baseName,
        displayName,
        authType,
        fields: [],
      };
    default: {
      // Exhaustive-case assertion: if a new authType is added and this
      // switch isn't updated, TS will flag this branch.
      const _exhaustive: never = authType;
      throw new Error(`unhandled authType: ${String(_exhaustive)}`);
    }
  }
}
