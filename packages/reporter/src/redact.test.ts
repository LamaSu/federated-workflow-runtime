import { describe, expect, it } from "vitest";
import {
  redactString,
  extractShape,
  redactHeaders,
  pseudonymize,
} from "./redact.js";

// ────────────────────────────────────────────────────────────────────────────
// The 9 PII patterns from ARCHITECTURE.md §6.2. Each gets its own test.
// If you remove or weaken a pattern, update the corresponding test.
// ────────────────────────────────────────────────────────────────────────────

describe("redactString — 9 PII patterns", () => {
  it("(1) redacts email addresses", () => {
    const out = redactString("user john@acme.com failed login");
    expect(out).not.toContain("john@acme.com");
    expect(out).toContain("{redacted:email}");
  });

  it("(1) redacts multiple emails in one string", () => {
    const out = redactString("cc: a@b.com, d@e.io and f+tag@g.co.uk");
    expect(out).not.toMatch(/[a-z]+@[a-z]/i);
    // Three replacements.
    expect(out.match(/\{redacted:email\}/g)?.length).toBe(3);
  });

  it("(2) redacts credit card numbers with and without separators", () => {
    const out = redactString("card 4242 4242 4242 4242 declined; backup 4111-1111-1111-1111");
    expect(out).not.toContain("4242 4242");
    expect(out).not.toContain("4111-1111");
    expect(out).toContain("{redacted:credit-card}");
  });

  it("(2) redacts raw 16-digit PANs", () => {
    const out = redactString("pan=4242424242424242 ");
    expect(out).not.toContain("4242424242424242");
  });

  it("(3) redacts phone numbers in several formats", () => {
    const cases = [
      "call +1 555 123 4567",
      "contact 555-123-4567 now",
      "phone (555) 123-4567",
      "intl +44 20 7946 0958",
    ];
    for (const c of cases) {
      const out = redactString(c);
      expect(out).toContain("{redacted:phone}");
    }
  });

  it("(4) redacts JWT tokens", () => {
    // Realistic-looking three-segment JWT (header.payload.signature)
    const jwt =
      "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9" +
      ".eyJzdWIiOiIxMjM0NTY3ODkwIiwibmFtZSI6IkpvaG4ifQ" +
      ".dozjgNryP4J3jVmNHl0w5N_XgL0n3I9PlFUP0THsR8U";
    const out = redactString(`authorization: Bearer ${jwt}`);
    expect(out).not.toContain("eyJhbGci");
    // Should be redacted (either by jwt pattern or bearer pattern — both work)
    expect(out).toMatch(/\{redacted:(jwt|bearer)\}/);
  });

  it("(5) redacts Stripe-style secret keys (sk_live_/sk_test_)", () => {
    const fakeKey = ["sk", "live", "51abcdEfghIjkLmnoPqrstuVwxyz0123456789"].join("_");
    const out = redactString(`stripe key: ${fakeKey}`);
    expect(out).not.toContain("sk_live_51abcd");
    expect(out).toContain("{redacted:");
  });

  it("(5) redacts generic API keys", () => {
    const out = redactString(
      "token=ghp_aB3cD4eF5gH6iJ7kL8mN9oP0qR1sT2uV3wX4yZ",
    );
    expect(out).not.toContain("ghp_aB3cD4");
  });

  it("(6) redacts Bearer tokens", () => {
    const out = redactString(
      "Authorization: Bearer abc123XYZdef456GHIjkl789MNOpqr",
    );
    expect(out).toContain("{redacted:bearer}");
    expect(out).not.toContain("abc123XYZdef456");
  });

  it("(7) redacts IPv4 addresses", () => {
    const out = redactString("request from 192.168.1.42 rejected; origin 203.0.113.9");
    expect(out).not.toContain("192.168.1.42");
    expect(out).not.toContain("203.0.113.9");
    expect(out.match(/\{redacted:ipv4\}/g)?.length).toBe(2);
  });

  it("(7) does NOT redact non-IP digit strings that happen to have dots", () => {
    // Version string — must survive intact.
    const out = redactString("running chorus/0.1.0 reporter");
    expect(out).toContain("0.1.0");
  });

  it("(8) redacts US Social Security numbers", () => {
    const out = redactString("ssn on file: 123-45-6789");
    expect(out).not.toContain("123-45-6789");
    expect(out).toContain("{redacted:ssn}");
  });

  it("(9) redacts AWS access key IDs", () => {
    const out = redactString(
      "aws key AKIAIOSFODNN7EXAMPLE detected in logs",
    );
    expect(out).not.toContain("AKIAIOSFODNN7EXAMPLE");
    expect(out).toContain("{redacted:aws-key-id}");
  });

  it("(9) redacts AWS secret access keys (40-char base64)", () => {
    const out = redactString(
      "secret=wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
    );
    expect(out).not.toContain("wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY");
  });

  // ── Additional sanity checks ──────────────────────────────────────────────

  it("is idempotent — running twice yields the same result", () => {
    const once = redactString("user a@b.com");
    const twice = redactString(once);
    expect(twice).toBe(once);
  });

  it("passes clean strings through unchanged", () => {
    expect(redactString("integration version 1.4.2")).toBe(
      "integration version 1.4.2",
    );
  });

  it("handles empty and non-string inputs gracefully", () => {
    expect(redactString("")).toBe("");
    expect(redactString(null as unknown as string)).toBe(null as unknown as string);
  });
});

describe("extractShape", () => {
  it("returns type name for primitives", () => {
    expect(extractShape("hello")).toBe("string");
    expect(extractShape(42)).toBe("integer");
    expect(extractShape(3.14)).toBe("number");
    expect(extractShape(true)).toBe("boolean");
    expect(extractShape(null)).toBe("null");
    expect(extractShape(undefined)).toBe("undefined");
  });

  it("describes arrays by length", () => {
    expect(extractShape([])).toBe("array[0]");
    expect(extractShape([1, 2, 3])).toBe("array[3]");
  });

  it("recursively describes objects", () => {
    const shape = extractShape({ a: 1, b: "x", c: true });
    expect(shape).toEqual({ a: "integer", b: "string", c: "boolean" });
  });

  it("recurses into nested objects — and never leaks values", () => {
    const shape = extractShape({
      user: { id: 1, email: "someone@example.com" },
      items: [1, 2, 3],
      meta: { ts: "2026-04-13", nested: { deep: 42 } },
    });
    expect(shape).toEqual({
      user: { id: "integer", email: "string" },
      items: "array[3]",
      meta: {
        ts: "string",
        nested: { deep: "integer" },
      },
    });
    // Crucially, no email value anywhere.
    const asString = JSON.stringify(shape);
    expect(asString).not.toContain("someone@example.com");
  });

  it("truncates at maxDepth", () => {
    const deep: Record<string, unknown> = { v: "leaf" };
    let cur = deep;
    for (let i = 0; i < 20; i++) {
      const next: Record<string, unknown> = { v: "leaf" };
      cur.n = next;
      cur = next;
    }
    const shape = extractShape(deep, 0, 3);
    const s = JSON.stringify(shape);
    // Should eventually hit "truncated" — don't recurse forever.
    expect(s).toContain("truncated");
  });

  it("recognizes Date/RegExp/Error without recursing into them", () => {
    expect(extractShape(new Date())).toBe("date");
    expect(extractShape(/re/)).toBe("regexp");
    expect(extractShape(new Error("x"))).toBe("error");
  });
});

describe("redactHeaders", () => {
  it("preserves names but strips most values", () => {
    const out = redactHeaders({
      Authorization: "Bearer abc123XYZdef456GHIjkl",
      "X-Secret-Token": "super-secret",
      "Content-Type": "application/json",
    });
    expect(out.authorization).toBe("<string>");
    expect(out["x-secret-token"]).toBe("<string>");
    // Content-Type is allowlisted so value survives.
    expect(out["content-type"]).toBe("application/json");
  });

  it("allowlisted headers still have their values PII-scrubbed", () => {
    const out = redactHeaders({
      "X-Request-Id": "req-for-user@example.com-12345",
    });
    expect(out["x-request-id"]).not.toContain("user@example.com");
  });

  it("handles undefined headers", () => {
    expect(redactHeaders(undefined)).toEqual({});
  });

  it("lowercases all header names", () => {
    const out = redactHeaders({ "X-Api-Version": "2024-02-01" });
    expect(out["x-api-version"]).toBe("2024-02-01");
    expect(out["X-Api-Version"]).toBeUndefined();
  });
});

describe("pseudonymize", () => {
  it("returns a stable 16-char hex string for the same input + salt", () => {
    const a = pseudonymize("user@example.com", "salt-1");
    const b = pseudonymize("user@example.com", "salt-1");
    expect(a).toBe(b);
    expect(a).toMatch(/^[a-f0-9]{16}$/);
  });

  it("different salt yields different output", () => {
    const a = pseudonymize("user@example.com", "salt-1");
    const b = pseudonymize("user@example.com", "salt-2");
    expect(a).not.toBe(b);
  });

  it("never returns the input string", () => {
    expect(pseudonymize("user@example.com", "s")).not.toContain("user");
  });

  it("throws on missing salt", () => {
    expect(() => pseudonymize("x", "")).toThrow(/salt/);
  });
});
