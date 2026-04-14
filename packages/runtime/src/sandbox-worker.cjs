// Sandbox worker shim. Loaded by fork() from sandbox.ts.
//
// Contract:
//   parent -> child: { type: "invoke", handlerPath, exportName, input }
//   child  -> parent: { type: "result", output }
//                   | { type: "error",  message, stack?, code?, name? }
//
// Deliberately plain JS so it needs no transpilation. Keeps the subprocess
// boot time <100ms.

"use strict";

const { pathToFileURL } = require("node:url");

process.on("message", async (msg) => {
  if (!msg || typeof msg !== "object" || msg.type !== "invoke") {
    send({ type: "error", message: "sandbox-worker: unexpected message shape" });
    return;
  }

  const { handlerPath, exportName, input } = msg;
  try {
    const url = pathToFileURL(handlerPath).href;
    // Dynamic import works for both ESM and CJS (Node wraps CJS as ESM).
    const mod = await import(url);
    const handler = mod[exportName];
    if (typeof handler !== "function") {
      send({
        type: "error",
        message:
          `sandbox-worker: export "${exportName}" on "${handlerPath}" is not a function ` +
          `(got ${typeof handler})`,
      });
      return;
    }
    const output = await handler(input);
    send({ type: "result", output });
  } catch (err) {
    const e = err instanceof Error ? err : new Error(String(err));
    send({
      type: "error",
      message: e.message,
      stack: e.stack,
      code: e.code,
      name: e.name,
    });
  }
});

function send(msg) {
  if (typeof process.send === "function") {
    process.send(msg);
  }
}

// Catch hard errors so we still emit an error message before exit.
process.on("uncaughtException", (err) => {
  send({
    type: "error",
    message: `uncaughtException in sandbox: ${err.message}`,
    stack: err.stack,
  });
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  const err = reason instanceof Error ? reason : new Error(String(reason));
  send({
    type: "error",
    message: `unhandledRejection in sandbox: ${err.message}`,
    stack: err.stack,
  });
  process.exit(1);
});
