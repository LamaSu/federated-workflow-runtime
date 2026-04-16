/**
 * @delightfulchorus/service-catalog
 *
 * Typed service catalog for Chorus. 40+ REST services declared as JSON,
 * validated against a Zod schema at load time, and exposed via a simple
 * runtime API consumed by `@delightfulchorus/integration-universal-http`.
 *
 * Usage:
 *   import { getService, listServices } from "@delightfulchorus/service-catalog";
 *   const github = getService("github");
 *   const ops    = github?.commonOperations;
 */
export {
  ServiceDefinitionSchema,
  AuthTypeEntrySchema,
  OperationEntrySchema,
  AuthHeaderSchema,
  CredentialFieldSchema,
  CredentialOAuth2FlowSchema,
  type ServiceDefinition,
  type AuthTypeEntry,
  type OperationEntry,
  type AuthHeader,
} from "./schemas.js";

import { SERVICE_INDEX } from "./loader.js";
import type { ServiceDefinition } from "./schemas.js";

/**
 * Look up a service definition by its stable `serviceId` (kebab-case).
 * Returns `null` when the catalog has no entry — callers decide whether that
 * is a user error (unknown service) or a cue to fall back to ad-hoc HTTP.
 */
export function getService(serviceId: string): ServiceDefinition | null {
  return SERVICE_INDEX.get(serviceId) ?? null;
}

/**
 * Return every service definition in the catalog. Useful for rendering a
 * picker in the CLI / MCP / workflow builder.
 *
 * Ordering is by serviceId (alphabetical) so the output is deterministic
 * regardless of the underlying Map iteration order.
 */
export function listServices(): ServiceDefinition[] {
  return [...SERVICE_INDEX.values()].sort((a, b) =>
    a.serviceId < b.serviceId ? -1 : a.serviceId > b.serviceId ? 1 : 0,
  );
}

/**
 * Return just the service IDs (kebab-case strings). Equivalent to
 * `listServices().map(s => s.serviceId)` but cheaper when callers only need
 * the IDs (e.g. for autocomplete).
 */
export function listServiceIds(): string[] {
  return [...SERVICE_INDEX.keys()].sort();
}

/**
 * Return the count of services currently in the catalog. Mostly for tests
 * that want to assert "we actually loaded all 40" without enumerating them.
 */
export function catalogSize(): number {
  return SERVICE_INDEX.size;
}
