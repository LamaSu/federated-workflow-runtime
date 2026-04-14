import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { ChorusConfigSchema, ConfigNotFoundError, loadConfigFromDir, parseConfig } from "./config.js";

let tmpDir: string;

beforeEach(async () => {
  tmpDir = await mkdtemp(path.join(tmpdir(), "chorus-config-test-"));
});

afterEach(async () => {
  await rm(tmpDir, { recursive: true, force: true });
});

describe("ChorusConfigSchema", () => {
  it("fills defaults from a minimal input", () => {
    const result = ChorusConfigSchema.parse({ name: "hello" });
    expect(result.name).toBe("hello");
    expect(result.version).toBe(1);
    expect(result.database.path).toBe(".chorus/chorus.db");
    expect(result.server.port).toBe(3710);
    expect(result.server.host).toBe("127.0.0.1");
    expect(result.repair.autoAttempt).toBe(false);
    expect(result.registry.url).toBe("https://registry.chorus.dev");
  });

  it("rejects missing name", () => {
    expect(() => ChorusConfigSchema.parse({})).toThrow();
  });

  it("rejects invalid port", () => {
    expect(() =>
      ChorusConfigSchema.parse({ name: "x", server: { port: 70_000 } }),
    ).toThrow();
  });

  it("rejects unknown top-level keys (strict mode)", () => {
    expect(() => ChorusConfigSchema.parse({ name: "x", surprise: 1 })).toThrow();
  });
});

describe("parseConfig (YAML)", () => {
  it("parses a minimal YAML config", () => {
    const yaml = `name: hello\n`;
    const config = parseConfig(yaml);
    expect(config.name).toBe("hello");
  });

  it("parses a nested YAML config", () => {
    const yaml = [
      "name: my-project",
      "version: 1",
      "database:",
      "  path: /var/chorus/db.sqlite",
      "server:",
      "  host: 0.0.0.0",
      "  port: 9000",
      "repair:",
      "  autoAttempt: true",
      "  dailyBudget: 20",
      "registry:",
      "  url: https://reg.example.com",
      "",
    ].join("\n");
    const config = parseConfig(yaml);
    expect(config.database.path).toBe("/var/chorus/db.sqlite");
    expect(config.server.port).toBe(9000);
    expect(config.repair.autoAttempt).toBe(true);
    expect(config.registry.url).toBe("https://reg.example.com");
  });

  it("parses JSON too (YAML is a JSON superset)", () => {
    const json = `{"name": "jsonly", "server": {"port": 1234}}`;
    const config = parseConfig(json);
    expect(config.name).toBe("jsonly");
    expect(config.server.port).toBe(1234);
  });

  it("throws on malformed input", () => {
    expect(() => parseConfig("name: hello\n  bad_indent: 1")).toThrow();
  });
});

describe("loadConfigFromDir", () => {
  it("loads config.yaml when present", async () => {
    const dir = path.join(tmpDir, "chorus");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.yaml"), "name: loaded-yaml\n");
    const result = await loadConfigFromDir(dir);
    expect(result.config.name).toBe("loaded-yaml");
    expect(result.path).toBe(path.join(dir, "config.yaml"));
    expect(result.chorusDir).toBe(dir);
  });

  it("falls back to config.json if no yaml", async () => {
    const dir = path.join(tmpDir, "chorus");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.json"), JSON.stringify({ name: "loaded-json" }));
    const result = await loadConfigFromDir(dir);
    expect(result.config.name).toBe("loaded-json");
  });

  it("throws ConfigNotFoundError when no config exists", async () => {
    const dir = path.join(tmpDir, "chorus");
    await mkdir(dir, { recursive: true });
    await expect(loadConfigFromDir(dir)).rejects.toBeInstanceOf(ConfigNotFoundError);
  });

  it("throws when config is invalid (wrong schema)", async () => {
    const dir = path.join(tmpDir, "chorus");
    await mkdir(dir, { recursive: true });
    await writeFile(path.join(dir, "config.yaml"), "version: 1\n"); // missing name
    await expect(loadConfigFromDir(dir)).rejects.toThrow();
  });
});
