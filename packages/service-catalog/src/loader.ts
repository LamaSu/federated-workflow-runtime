/**
 * @delightfulchorus/service-catalog — loader
 *
 * Loads all service JSON files from `src/services/` at module init, validates
 * each one against `ServiceDefinitionSchema`, and exposes a simple in-memory
 * index.
 *
 * Bundling strategy: we use static imports (with `resolveJsonModule` + `with`)
 * so that tsup/tsc inline each JSON at build time. This keeps the published
 * package self-contained — no runtime filesystem reads, no ESM file:// URL
 * gymnastics, no conditional exports per environment.
 *
 * Adding a new service:
 *   1. Drop `services/<serviceId>.json` into this folder
 *   2. Import + push it into ALL_SERVICES below
 *   3. Tests will validate it end-to-end on next run
 */
import { ServiceDefinitionSchema, type ServiceDefinition } from "./schemas.js";

// ── Service imports (one per JSON file) ─────────────────────────────────────

import githubDef from "./services/github.json" with { type: "json" };
import googleSheetsDef from "./services/google-sheets.json" with { type: "json" };
import notionDef from "./services/notion.json" with { type: "json" };
import airtableDef from "./services/airtable.json" with { type: "json" };
import openaiDef from "./services/openai.json" with { type: "json" };
import anthropicDef from "./services/anthropic.json" with { type: "json" };
import linearDef from "./services/linear.json" with { type: "json" };
import discordDef from "./services/discord.json" with { type: "json" };
import telegramDef from "./services/telegram.json" with { type: "json" };
import twilioDef from "./services/twilio.json" with { type: "json" };
import sendgridDef from "./services/sendgrid.json" with { type: "json" };
import hubspotDef from "./services/hubspot.json" with { type: "json" };
import jiraDef from "./services/jira.json" with { type: "json" };
import zendeskDef from "./services/zendesk.json" with { type: "json" };
import intercomDef from "./services/intercom.json" with { type: "json" };
import shopifyDef from "./services/shopify.json" with { type: "json" };
import mailchimpDef from "./services/mailchimp.json" with { type: "json" };
import segmentDef from "./services/segment.json" with { type: "json" };
import mixpanelDef from "./services/mixpanel.json" with { type: "json" };
import posthogDef from "./services/posthog.json" with { type: "json" };
import sentryDef from "./services/sentry.json" with { type: "json" };
import circleciDef from "./services/circleci.json" with { type: "json" };
import gitlabDef from "./services/gitlab.json" with { type: "json" };
import bitbucketDef from "./services/bitbucket.json" with { type: "json" };
import netlifyDef from "./services/netlify.json" with { type: "json" };
import vercelDef from "./services/vercel.json" with { type: "json" };
import cloudflareDef from "./services/cloudflare.json" with { type: "json" };
import dropboxDef from "./services/dropbox.json" with { type: "json" };
import boxDef from "./services/box.json" with { type: "json" };
import googleDriveDef from "./services/google-drive.json" with { type: "json" };
import onedriveDef from "./services/onedrive.json" with { type: "json" };
import calendlyDef from "./services/calendly.json" with { type: "json" };
import googleCalendarDef from "./services/google-calendar.json" with { type: "json" };
import asanaDef from "./services/asana.json" with { type: "json" };
import trelloDef from "./services/trello.json" with { type: "json" };
import clickupDef from "./services/clickup.json" with { type: "json" };
import basecampDef from "./services/basecamp.json" with { type: "json" };
import zoomDef from "./services/zoom.json" with { type: "json" };
import googleMeetDef from "./services/google-meet.json" with { type: "json" };
import webexDef from "./services/webex.json" with { type: "json" };

// ── Validation + registration ───────────────────────────────────────────────

const RAW_SERVICES: unknown[] = [
  githubDef,
  googleSheetsDef,
  notionDef,
  airtableDef,
  openaiDef,
  anthropicDef,
  linearDef,
  discordDef,
  telegramDef,
  twilioDef,
  sendgridDef,
  hubspotDef,
  jiraDef,
  zendeskDef,
  intercomDef,
  shopifyDef,
  mailchimpDef,
  segmentDef,
  mixpanelDef,
  posthogDef,
  sentryDef,
  circleciDef,
  gitlabDef,
  bitbucketDef,
  netlifyDef,
  vercelDef,
  cloudflareDef,
  dropboxDef,
  boxDef,
  googleDriveDef,
  onedriveDef,
  calendlyDef,
  googleCalendarDef,
  asanaDef,
  trelloDef,
  clickupDef,
  basecampDef,
  zoomDef,
  googleMeetDef,
  webexDef,
];

/**
 * Validate every raw JSON blob against the schema at module load. A malformed
 * catalog entry should be a loud build/test failure — not a runtime surprise.
 * We build an index keyed by serviceId for O(1) lookup.
 */
function buildIndex(): ReadonlyMap<string, ServiceDefinition> {
  const map = new Map<string, ServiceDefinition>();
  for (const raw of RAW_SERVICES) {
    const parsed = ServiceDefinitionSchema.parse(raw);
    if (map.has(parsed.serviceId)) {
      throw new Error(
        `duplicate serviceId in catalog: ${parsed.serviceId}`,
      );
    }
    map.set(parsed.serviceId, parsed);
  }
  return map;
}

export const SERVICE_INDEX: ReadonlyMap<string, ServiceDefinition> = buildIndex();
