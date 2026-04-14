import { describe, expect, it } from "vitest";
import Fastify from "fastify";
import { openDatabase } from "../db.js";
import { RunQueue } from "../queue.js";
import {
  DEFAULT_SIGNATURE_HEADER,
  WebhookRegistry,
  signWebhookBody,
  verifyWebhookSignature,
} from "./webhook.js";

function setup() {
  const db = openDatabase(":memory:");
  const q = new RunQueue(db);
  return { db, q };
}

describe("webhook signature helpers", () => {
  it("signWebhookBody returns a 64-char hex string", () => {
    const s = signWebhookBody("secret", "hello");
    expect(s).toMatch(/^[a-f0-9]{64}$/);
  });

  it("verifyWebhookSignature accepts correct signatures", () => {
    const body = '{"a":1}';
    const sig = signWebhookBody("my-secret", body);
    expect(verifyWebhookSignature("my-secret", body, sig)).toBe(true);
  });

  it("verifyWebhookSignature rejects wrong signatures", () => {
    const body = '{"a":1}';
    const sig = signWebhookBody("my-secret", body);
    expect(verifyWebhookSignature("wrong-secret", body, sig)).toBe(false);
  });

  it("verifyWebhookSignature rejects missing signature", () => {
    expect(verifyWebhookSignature("x", "body", undefined)).toBe(false);
  });

  it("verifyWebhookSignature rejects wrong length", () => {
    expect(verifyWebhookSignature("x", "body", "abcd")).toBe(false);
  });
});

describe("WebhookRegistry — via full Fastify server", () => {
  it("enqueues a run on a valid POST with no secret", async () => {
    const { db, q } = setup();
    const app = Fastify({ logger: false });
    const reg = new WebhookRegistry({
      queue: q,
      now: () => new Date("2026-04-13T00:00:00.000Z"),
    });
    reg.register({
      workflowId: "wf-1",
      token: "tok-abc",
      config: { type: "webhook", path: "/hooks/wf-1/tok-abc", method: "POST" },
    });
    reg.installRoutes(app);
    const res = await app.inject({
      method: "POST",
      url: "/hooks/wf-1/tok-abc",
      payload: { hello: "world" },
    });
    expect(res.statusCode).toBe(202);
    const body = res.json() as { runId: string };
    expect(body.runId).toMatch(/[0-9a-f-]{8,}/);
    expect(q.pendingCount()).toBe(1);
    await app.close();
    db.close();
  });

  it("returns 404 for unregistered path", async () => {
    const { db, q } = setup();
    const app = Fastify({ logger: false });
    const reg = new WebhookRegistry({ queue: q });
    reg.installRoutes(app);
    const res = await app.inject({ method: "POST", url: "/hooks/unknown/tok" });
    expect(res.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it("returns 405 when HTTP method doesn't match trigger config", async () => {
    const { db, q } = setup();
    const app = Fastify({ logger: false });
    const reg = new WebhookRegistry({ queue: q });
    reg.register({
      workflowId: "wf-2",
      token: "tok-2",
      config: { type: "webhook", path: "/hooks/wf-2/tok-2", method: "POST" },
    });
    reg.installRoutes(app);
    const res = await app.inject({ method: "GET", url: "/hooks/wf-2/tok-2" });
    expect(res.statusCode).toBe(405);
    await app.close();
    db.close();
  });

  it("rejects requests missing a required signature", async () => {
    const { db, q } = setup();
    const app = Fastify({ logger: false });
    const reg = new WebhookRegistry({ queue: q });
    reg.register({
      workflowId: "wf-secure",
      token: "tok-s",
      config: {
        type: "webhook",
        path: "/hooks/wf-secure/tok-s",
        method: "POST",
        secret: "supersecret",
      },
    });
    reg.installRoutes(app);
    const res = await app.inject({
      method: "POST",
      url: "/hooks/wf-secure/tok-s",
      payload: { a: 1 },
    });
    expect(res.statusCode).toBe(401);
    expect(q.pendingCount()).toBe(0);
    await app.close();
    db.close();
  });

  it("accepts requests with a valid signature", async () => {
    const { db, q } = setup();
    const app = Fastify({ logger: false });
    const reg = new WebhookRegistry({ queue: q });
    reg.register({
      workflowId: "wf-secure2",
      token: "tok-s2",
      config: {
        type: "webhook",
        path: "/hooks/wf-secure2/tok-s2",
        method: "POST",
        secret: "supersecret",
      },
    });
    reg.installRoutes(app);
    const rawBody = JSON.stringify({ a: 1 });
    const sig = signWebhookBody("supersecret", rawBody);
    const res = await app.inject({
      method: "POST",
      url: "/hooks/wf-secure2/tok-s2",
      payload: rawBody,
      headers: {
        "content-type": "application/json",
        [DEFAULT_SIGNATURE_HEADER]: sig,
      },
    });
    expect(res.statusCode).toBe(202);
    expect(q.pendingCount()).toBe(1);
    await app.close();
    db.close();
  });

  it("unregister removes the route mapping", async () => {
    const { db, q } = setup();
    const app = Fastify({ logger: false });
    const reg = new WebhookRegistry({ queue: q });
    reg.register({
      workflowId: "wf-u",
      token: "tok-u",
      config: { type: "webhook", path: "/hooks/wf-u/tok-u", method: "POST" },
    });
    reg.installRoutes(app);
    reg.unregister("wf-u", "tok-u");
    const res = await app.inject({ method: "POST", url: "/hooks/wf-u/tok-u" });
    expect(res.statusCode).toBe(404);
    await app.close();
    db.close();
  });

  it("refuses duplicate registration", () => {
    const { db, q } = setup();
    const reg = new WebhookRegistry({ queue: q });
    reg.register({
      workflowId: "wf-dup",
      token: "tok-d",
      config: { type: "webhook", path: "/hooks/wf-dup/tok-d", method: "POST" },
    });
    expect(() =>
      reg.register({
        workflowId: "wf-dup",
        token: "tok-d",
        config: { type: "webhook", path: "/hooks/wf-dup/tok-d", method: "POST" },
      }),
    ).toThrow(/already registered/);
    db.close();
  });
});
