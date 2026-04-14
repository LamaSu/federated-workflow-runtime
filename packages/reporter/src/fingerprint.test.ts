import { describe, expect, it } from "vitest";
import { fingerprintConfig } from "./fingerprint.js";

describe("fingerprintConfig", () => {
  it("returns an empty object for undefined/null input", () => {
    expect(fingerprintConfig(undefined)).toEqual({});
    expect(fingerprintConfig(null)).toEqual({});
  });

  it("preserves boolean flags verbatim", () => {
    const out = fingerprintConfig({
      unfurl_links: true,
      verbose: false,
    });
    expect(out).toEqual({ unfurl_links: true, verbose: false });
  });

  it("preserves integer and finite numeric knobs", () => {
    const out = fingerprintConfig({
      timeoutMs: 3000,
      maxRetries: 5,
      backoffFactor: 1.5,
    });
    expect(out.timeoutMs).toBe(3000);
    expect(out.maxRetries).toBe(5);
    expect(out.backoffFactor).toBe(1.5);
  });

  it("labels non-finite numbers as strings", () => {
    const out = fingerprintConfig({ weird: NaN, inf: Infinity });
    expect(out.weird).toBe("number:NaN");
    expect(out.inf).toBe("number:Infinity");
  });

  it("redacts credential-ish keys regardless of value", () => {
    const out = fingerprintConfig({
      apiKey: "sk_live_abcdef1234567890",
      password: "hunter2",
      client_secret: "shh",
      accessToken: "abc",
      sessionCookie: "s=xyz",
    });
    for (const v of Object.values(out)) {
      expect(v).toBe("credential:present");
    }
    // Values never appear.
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk_live");
    expect(json).not.toContain("hunter2");
    expect(json).not.toContain("shh");
  });

  it("marks absent credentials with sentinel", () => {
    const out = fingerprintConfig({
      apiKey: "",
      password: null,
      accessToken: undefined,
    });
    expect(out.apiKey).toBe("credential:absent");
    expect(out.password).toBe("credential:absent");
    expect(out.accessToken).toBe("credential:absent");
  });

  it("replaces string values with shape labels", () => {
    const out = fingerprintConfig({
      baseUrl: "https://api.stripe.com/v1",
      version: "2023-10-16",
      emailTo: "ops@acme.com",
      phone: "+15551234567",
    });
    expect(out.baseUrl).toBe("string:url");
    expect(out.version).toMatch(/^string:/);
    expect(out.emailTo).toBe("string:email");
    expect(out.phone).toBe("string:phone");
    // Values never appear in output.
    const json = JSON.stringify(out);
    expect(json).not.toContain("stripe.com");
    expect(json).not.toContain("ops@acme.com");
    expect(json).not.toContain("5551234567");
  });

  it("collapses nested objects to 'shape'", () => {
    const out = fingerprintConfig({
      retry: { max: 3, backoff: 200 },
      headers: { "x-custom": "value" },
    });
    expect(out.retry).toBe("shape");
    expect(out.headers).toBe("shape");
  });

  it("records array length, not contents", () => {
    const out = fingerprintConfig({
      channels: ["#ops", "#alerts"],
      empty: [],
    });
    expect(out.channels).toBe("array[2]");
    expect(out.empty).toBe("array[0]");
  });

  it("passes through common config archetype end-to-end", () => {
    const out = fingerprintConfig({
      apiKey: "sk_live_XXXXXXXXXX",
      baseUrl: "https://hooks.slack.com/services/T00/B00/xxxx",
      unfurl_links: true,
      unfurl_media: false,
      timeoutMs: 5000,
      maxRetries: 3,
      channel: "#ops",
    });

    // Output shape check.
    expect(Object.keys(out).sort()).toEqual([
      "apiKey",
      "baseUrl",
      "channel",
      "maxRetries",
      "timeoutMs",
      "unfurl_links",
      "unfurl_media",
    ]);

    expect(out.apiKey).toBe("credential:present");
    expect(out.baseUrl).toBe("string:url");
    expect(out.unfurl_links).toBe(true);
    expect(out.unfurl_media).toBe(false);
    expect(out.timeoutMs).toBe(5000);
    expect(out.maxRetries).toBe(3);
    expect(typeof out.channel).toBe("string");

    // The actual API key must never appear in the output.
    const json = JSON.stringify(out);
    expect(json).not.toContain("sk_live");
    expect(json).not.toContain("hooks.slack.com");
    expect(json).not.toContain("#ops");
  });

  it("every output value satisfies the schema's scalar contract", () => {
    const out = fingerprintConfig({
      a: "x",
      b: 1,
      c: true,
      d: { nested: true },
      e: ["arr"],
      f: null,
      g: undefined,
    });
    for (const v of Object.values(out)) {
      const t = typeof v;
      expect(t === "string" || t === "boolean" || t === "number").toBe(true);
    }
  });
});
