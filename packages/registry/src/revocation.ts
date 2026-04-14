/**
 * Revocation fast-path per ARCHITECTURE.md §5.6.
 *
 * Clients poll `revoked.json` every 5 minutes + on every integration run. On finding
 * a new revocation, they uninstall the patch (swap back to pre-patch version) and
 * emit telemetry.
 *
 * The list MUST be signed (§5.6: "Publishing a revocation IS a signing event"). For the
 * MVP we require the loader to accept a separate signature or trust the transport — a
 * real implementation would use sigstore here. This module ships:
 *   - schema + parse
 *   - simple poller that swallows transient fetch errors
 * It does NOT yet enforce signature verification on the list itself — that's wired in
 * when the distribution CDN is in place.
 */

import { z } from "zod";

export const RevocationEntrySchema = z.object({
  patchId: z.string(),
  reason: z.string(),
  severity: z.enum(["low", "medium", "high", "critical"]),
  revokedAt: z.string(),
});

export const RevocationListSchema = z.object({
  schemaVersion: z.literal("1.0.0"),
  asOf: z.string(),
  revoked: z.array(RevocationEntrySchema),
  signature: z.string().optional(),
  rekorLogIndex: z.number().int().optional(),
});

export type RevocationEntry = z.infer<typeof RevocationEntrySchema>;
export type RevocationList = z.infer<typeof RevocationListSchema>;

/**
 * Fetch + parse a revocation list from a URL.
 *
 * Uses globalThis.fetch (Node 20+). We do NOT add retry here — callers should re-invoke
 * on the poll interval. Returns Error (not throws) for network or parse failures so the
 * poller can keep the last-known-good list on transient flakes.
 */
export async function loadRevocationList(url: string, fetchImpl: typeof fetch = fetch): Promise<RevocationList | Error> {
  try {
    const res = await fetchImpl(url);
    if (!res.ok) return new Error(`revocation fetch ${url}: HTTP ${res.status}`);
    const raw = await res.json();
    const parsed = RevocationListSchema.safeParse(raw);
    if (!parsed.success) return new Error(`revocation parse: ${parsed.error.message}`);
    return parsed.data;
  } catch (err) {
    return err instanceof Error ? err : new Error(String(err));
  }
}

/** Constant-time-ish lookup (set-based) for whether a patch is on the kill list. */
export function isRevoked(patchId: string, list: RevocationList): boolean {
  for (const entry of list.revoked) {
    if (entry.patchId === patchId) return true;
  }
  return false;
}

export interface PollerDb {
  /** Called when a new revocation list is loaded. */
  setRevocationList(list: RevocationList): void | Promise<void>;
  /** Optional: called on fetch / parse failure. Poller continues on error. */
  onError?(err: Error): void | Promise<void>;
}

/**
 * Start a background poller that updates the db every `intervalMs`.
 *
 * Returns a stopper function. Calling it prevents any further poll AND clears the
 * outstanding timer synchronously, so tests don't dangle.
 */
export function startRevocationPoller(
  db: PollerDb,
  url: string,
  intervalMs: number,
  fetchImpl: typeof fetch = fetch,
): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let stopped = false;

  const tick = async () => {
    if (stopped) return;
    const result = await loadRevocationList(url, fetchImpl);
    if (stopped) return;
    if (result instanceof Error) {
      if (db.onError) await db.onError(result);
    } else {
      await db.setRevocationList(result);
    }
    if (!stopped) {
      timer = setTimeout(tick, intervalMs);
    }
  };

  // Kick off the first poll on next microtask so the caller can set up state first.
  timer = setTimeout(tick, 0);

  return () => {
    stopped = true;
    if (timer) {
      clearTimeout(timer);
      timer = null;
    }
  };
}
