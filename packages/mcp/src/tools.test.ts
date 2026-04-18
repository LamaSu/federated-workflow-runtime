import { describe, it, expect } from "vitest";
import {
  generateDashboardTool,
  handleGenerateDashboard,
  dispatchServerTool,
  GENERATE_DASHBOARD_TOOL_NAME,
  SERVER_LEVEL_TOOLS,
  type DashboardGenerator,
  type HandleGenerateDashboardDeps,
} from "./tools.js";

function makeDeps(
  overrides: Partial<{
    generator: DashboardGenerator;
    displayUrl: string;
    workflows: Array<{
      id: string;
      name: string;
      version: number;
      trigger: { type: string };
      nodes: unknown[];
    }>;
  }> = {},
): HandleGenerateDashboardDeps {
  return {
    getContext: async () => ({
      displayUrl: overrides.displayUrl ?? "http://127.0.0.1:3710",
      workflows:
        overrides.workflows ?? [
          {
            id: "w1",
            name: "One",
            version: 1,
            trigger: { type: "manual" },
            nodes: [],
          },
        ],
    }),
    generator:
      overrides.generator ??
      (async () => ({
        ok: true,
        source: "generated" as const,
        message: "fine",
        cacheKey: "abc",
      })),
  };
}

describe("generate_dashboard — tool shape", () => {
  it("has the expected name, description and schema", () => {
    expect(generateDashboardTool.name).toBe(GENERATE_DASHBOARD_TOOL_NAME);
    expect(generateDashboardTool.description).toMatch(/dashboard/i);
    const schema = generateDashboardTool.inputSchema as {
      type: string;
      properties: Record<string, { type: string; description: string }>;
      additionalProperties: boolean;
    };
    expect(schema.type).toBe("object");
    expect(schema.properties.prompt).toBeDefined();
    expect(schema.properties.force).toBeDefined();
    expect(schema.additionalProperties).toBe(false);
  });

  it("is listed in SERVER_LEVEL_TOOLS", () => {
    expect(SERVER_LEVEL_TOOLS.some((t) => t.name === GENERATE_DASHBOARD_TOOL_NAME)).toBe(
      true,
    );
  });
});

describe("handleGenerateDashboard", () => {
  it("passes inputs through to the generator and returns the dashboard URL", async () => {
    type GenOpts = Parameters<DashboardGenerator>[0];
    let seenOpts: GenOpts | undefined;
    const deps = makeDeps({
      generator: async (opts) => {
        seenOpts = opts;
        return {
          ok: true,
          source: "generated",
          message: "ok",
          cacheKey: "k1",
        };
      },
    });
    const out = await handleGenerateDashboard(
      { prompt: "make it green" },
      deps,
    );
    expect(out.ok).toBe(true);
    expect(out.url).toBe("http://127.0.0.1:3710/dashboard");
    expect(out.source).toBe("generated");
    expect(out.cacheKey).toBe("k1");
    expect(seenOpts).toBeDefined();
    const captured = seenOpts as GenOpts;
    expect(captured.customPrompt).toBe("make it green");
    // Custom prompts auto-set noCache=true
    expect(captured.noCache).toBe(true);
  });

  it("defaults to cached result when no prompt + no force", async () => {
    let seenNoCache: boolean | undefined;
    const deps = makeDeps({
      generator: async (opts) => {
        seenNoCache = opts.noCache;
        return {
          ok: true,
          source: "cache",
          message: "reused",
          cacheKey: "k2",
        };
      },
    });
    const out = await handleGenerateDashboard({}, deps);
    expect(out.ok).toBe(true);
    expect(out.source).toBe("cache");
    expect(seenNoCache).toBe(false);
  });

  it("honors explicit force=true with no prompt", async () => {
    let seenNoCache: boolean | undefined;
    const deps = makeDeps({
      generator: async (opts) => {
        seenNoCache = opts.noCache;
        return {
          ok: true,
          source: "generated",
          message: "forced",
          cacheKey: "k3",
        };
      },
    });
    const out = await handleGenerateDashboard({ force: true }, deps);
    expect(out.ok).toBe(true);
    expect(seenNoCache).toBe(true);
  });

  it("surfaces generator failures without throwing", async () => {
    const deps = makeDeps({
      generator: async () => {
        throw new Error("boom");
      },
    });
    const out = await handleGenerateDashboard({}, deps);
    expect(out.ok).toBe(false);
    expect(out.source).toBe("error");
    expect(out.message).toMatch(/boom/);
  });

  it("surfaces getContext failures without throwing", async () => {
    const deps: HandleGenerateDashboardDeps = {
      getContext: async () => {
        throw new Error("no ctx");
      },
      generator: async () => ({
        ok: true,
        source: "generated",
        message: "",
        cacheKey: null,
      }),
    };
    const out = await handleGenerateDashboard({}, deps);
    expect(out.ok).toBe(false);
    expect(out.source).toBe("error");
    expect(out.message).toMatch(/no ctx/);
  });
});

describe("dispatchServerTool", () => {
  it("routes generate_dashboard to handleGenerateDashboard and wraps in an MCP envelope", async () => {
    const deps = makeDeps();
    const res = await dispatchServerTool(
      { tool: GENERATE_DASHBOARD_TOOL_NAME, args: {} },
      deps,
    );
    expect(res.isError).toBe(false);
    expect(res.content).toHaveLength(1);
    const first = res.content[0];
    if (!first) throw new Error("expected at least one content entry");
    expect(first.type).toBe("text");
    const body = JSON.parse(first.text);
    expect(body.ok).toBe(true);
    expect(body.url).toMatch(/\/dashboard$/);
  });

  it("returns an error envelope for unknown server-level tools", async () => {
    const deps = makeDeps();
    const res = await dispatchServerTool(
      { tool: "some_mystery_tool", args: {} },
      deps,
    );
    expect(res.isError).toBe(true);
    const first = res.content[0];
    if (!first) throw new Error("expected at least one content entry");
    expect(first.text).toMatch(/unknown server-level tool/);
  });
});
