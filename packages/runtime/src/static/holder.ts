/**
 * Dashboard holder — owns the "current" HTML bytes that the `/` route
 * serves. Starts as the bundled minimal dashboard; `start-server.ts` may
 * overwrite it after the LLM generator returns a per-workflow custom
 * dashboard.
 *
 * Why a module-level singleton rather than a server option: the generation
 * is asynchronous AND happens after `app.listen()` (per the task — never
 * block startup on LLM). Routes capture the holder by closure, not by
 * value, so a later `setDashboard()` transparently upgrades `/`.
 */
import { MINIMAL_HTML } from "./index.js";

let currentHtml: string = MINIMAL_HTML;
let currentEtag: string = hashForEtag(MINIMAL_HTML);

/**
 * Replace the dashboard HTML. Subsequent GET `/` requests serve the new
 * bytes (and get a new ETag). Safe to call more than once.
 */
export function setDashboard(html: string): void {
  if (!html || typeof html !== "string") return;
  currentHtml = html;
  currentEtag = hashForEtag(html);
}

/**
 * Reset the dashboard to the bundled minimal HTML. Primarily for tests.
 */
export function resetDashboard(): void {
  currentHtml = MINIMAL_HTML;
  currentEtag = hashForEtag(MINIMAL_HTML);
}

export function getDashboardHtml(): string {
  return currentHtml;
}

export function getDashboardEtag(): string {
  return currentEtag;
}

/**
 * Tiny non-cryptographic hash for ETag generation. Good enough for client
 * cache-busting (the dashboard polls /api/* so HTML cache isn't critical)
 * and avoids pulling in crypto just for this.
 */
function hashForEtag(s: string): string {
  let h = 5381;
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) | 0;
  }
  return 'W/"' + (h >>> 0).toString(16) + "-" + s.length.toString(16) + '"';
}
