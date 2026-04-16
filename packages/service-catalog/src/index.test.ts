/**
 * @delightfulchorus/service-catalog — tests
 *
 * These run Zod validation against every catalog entry + assert the runtime
 * API (getService, listServices, listServiceIds, catalogSize) matches spec.
 * A failure here means either:
 *   - A service JSON drifted out of shape (fix the JSON)
 *   - The schema tightened and the JSON needs updating
 * Either way: loud, fast, deterministic.
 */
import { describe, expect, it } from "vitest";
import {
  catalogSize,
  getService,
  listServices,
  listServiceIds,
  ServiceDefinitionSchema,
  type ServiceDefinition,
} from "./index.js";

describe("@delightfulchorus/service-catalog — runtime API", () => {
  it("loads all 40 services", () => {
    expect(catalogSize()).toBe(40);
    expect(listServices()).toHaveLength(40);
    expect(listServiceIds()).toHaveLength(40);
  });

  it("returns service IDs in alphabetical order", () => {
    const ids = listServiceIds();
    const sorted = [...ids].sort();
    expect(ids).toEqual(sorted);
  });

  it("listServices() returns entries ordered by serviceId", () => {
    const services = listServices();
    const ids = services.map((s) => s.serviceId);
    expect(ids).toEqual([...ids].sort());
  });

  it("getService returns a valid ServiceDefinition for a known service", () => {
    const github = getService("github");
    expect(github).not.toBeNull();
    expect(github!.serviceId).toBe("github");
    expect(github!.displayName).toBe("GitHub");
    expect(github!.baseUrl).toBe("https://api.github.com");
  });

  it("getService returns null for an unknown service", () => {
    expect(getService("does-not-exist")).toBeNull();
    expect(getService("")).toBeNull();
  });

  it("every catalog entry round-trips through ServiceDefinitionSchema", () => {
    for (const service of listServices()) {
      // parse accepts the already-validated object; if this throws the
      // schema would be stricter than the loader's validation.
      const reparsed = ServiceDefinitionSchema.parse(service);
      expect(reparsed.serviceId).toBe(service.serviceId);
    }
  });
});

describe("catalog quality — every service has minimum shape", () => {
  it("every service has at least one authType", () => {
    for (const service of listServices()) {
      expect(
        service.authTypes.length,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("every service has at least one commonOperation", () => {
    for (const service of listServices()) {
      expect(
        service.commonOperations.length,
      ).toBeGreaterThanOrEqual(1);
    }
  });

  it("every OAuth2 authType has oauth metadata with an authorizeUrl + tokenUrl", () => {
    for (const service of listServices()) {
      for (const authType of service.authTypes) {
        if (authType.authType === "oauth2") {
          expect(authType.oauth).toBeDefined();
          expect(authType.oauth!.authorizeUrl).toMatch(/^https:\/\//);
          expect(authType.oauth!.tokenUrl).toMatch(/^https:\/\//);
        }
      }
    }
  });

  it("every service ID is kebab-case", () => {
    for (const id of listServiceIds()) {
      expect(id).toMatch(/^[a-z][a-z0-9-]*$/);
    }
  });

  it("every operation ID is kebab-case", () => {
    for (const service of listServices()) {
      for (const op of service.commonOperations) {
        expect(op.id).toMatch(/^[a-z][a-z0-9-]*$/);
      }
    }
  });

  it("every operation path starts with / (or http for absolute)", () => {
    for (const service of listServices()) {
      for (const op of service.commonOperations) {
        const okAbsolute = op.path.startsWith("http://") || op.path.startsWith("https://");
        const okRelative = op.path.startsWith("/");
        expect(okAbsolute || okRelative).toBe(true);
      }
    }
  });
});

describe("priority services — tricky auth cases", () => {
  it("GitHub offers both PAT (bearer) and OAuth flows", () => {
    const gh = getService("github")!;
    const ids = gh.authTypes.map((a) => a.id);
    expect(ids).toContain("githubPAT");
    expect(ids).toContain("githubOAuth");
    const pat = gh.authTypes.find((a) => a.id === "githubPAT")!;
    expect(pat.authHeader).toEqual({
      name: "Authorization",
      format: "Bearer {accessToken}",
    });
  });

  it("Notion Integration Token uses Bearer auth + requires Notion-Version header via field", () => {
    const notion = getService("notion")!;
    const tok = notion.authTypes.find((a) => a.id === "notionIntegrationToken")!;
    expect(tok.authHeader!.format).toBe("Bearer {accessToken}");
    // second field is the Notion-Version header
    const versionField = tok.fields.find((f) => f.name === "notionVersion");
    expect(versionField).toBeDefined();
    expect(versionField!.default).toBe("2022-06-28");
  });

  it("OpenAI is Bearer auth with Authorization header", () => {
    const openai = getService("openai")!;
    const tok = openai.authTypes[0]!;
    expect(tok.authType).toBe("bearer");
    expect(tok.authHeader!.name).toBe("Authorization");
    expect(tok.authHeader!.format).toBe("Bearer {accessToken}");
  });

  it("Anthropic uses x-api-key header (not Authorization: Bearer)", () => {
    const anthropic = getService("anthropic")!;
    const tok = anthropic.authTypes[0]!;
    expect(tok.authType).toBe("apiKey");
    expect(tok.authHeader!.name).toBe("x-api-key");
    expect(tok.authHeader!.format).toBe("{apiKey}");
    // no 'Bearer' prefix!
    expect(tok.authHeader!.format).not.toContain("Bearer");
  });

  it("Twilio uses HTTP Basic with {base64:username:password} template", () => {
    const twilio = getService("twilio")!;
    const tok = twilio.authTypes.find((a) => a.id === "twilioBasic")!;
    expect(tok.authType).toBe("basic");
    expect(tok.authHeader!.format).toContain("{base64:username:password}");
  });

  it("Telegram puts the bot token in the URL path (no authHeader)", () => {
    const tg = getService("telegram")!;
    const tok = tg.authTypes[0]!;
    expect(tok.authType).toBe("apiKey");
    // Telegram's quirk: token is a URL path segment, not a header
    expect(tok.authHeader).toBeUndefined();
    // The paths contain {botToken} as a path placeholder
    const hasTokenInPath = tg.commonOperations.some((op) => op.path.includes("{botToken}"));
    expect(hasTokenInPath).toBe(true);
  });

  it("Discord bot token uses 'Bot <token>' prefix (not 'Bearer')", () => {
    const discord = getService("discord")!;
    const bot = discord.authTypes.find((a) => a.id === "discordBotToken")!;
    expect(bot.authHeader!.format).toBe("Bot {botToken}");
  });

  it("Linear API key is raw in Authorization (no 'Bearer' prefix)", () => {
    const linear = getService("linear")!;
    const ak = linear.authTypes.find((a) => a.id === "linearAPIKey")!;
    expect(ak.authHeader!.format).toBe("{apiKey}");
    expect(ak.authHeader!.format).not.toContain("Bearer");
  });

  it("Cloudflare scoped token vs global key use different headers", () => {
    const cf = getService("cloudflare")!;
    const scoped = cf.authTypes.find((a) => a.id === "cloudflareAPIToken")!;
    const global = cf.authTypes.find((a) => a.id === "cloudflareGlobalKey")!;
    expect(scoped.authHeader!.name).toBe("Authorization");
    expect(global.authHeader!.name).toBe("X-Auth-Key");
  });

  it("Shopify uses X-Shopify-Access-Token (not Authorization)", () => {
    const shopify = getService("shopify")!;
    const tok = shopify.authTypes.find((a) => a.id === "shopifyAdminToken")!;
    expect(tok.authHeader!.name).toBe("X-Shopify-Access-Token");
  });
});

describe("10 priority services from scout-november exist", () => {
  // Scout's top-10 (excluding already-native slack-send, gmail-send, stripe,
  // postgres-query). Priority picks for the catalog:
  const top10 = [
    "github",
    "google-sheets",
    "notion",
    "airtable",
    "discord",
    "telegram",
    "twilio",
    "linear",
    "openai",
    "anthropic",
  ];

  for (const id of top10) {
    it(`loads ${id}`, () => {
      const service = getService(id) as ServiceDefinition;
      expect(service).not.toBeNull();
      expect(service.serviceId).toBe(id);
      expect(service.authTypes.length).toBeGreaterThanOrEqual(1);
      expect(service.commonOperations.length).toBeGreaterThanOrEqual(3);
    });
  }
});
