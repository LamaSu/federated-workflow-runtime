// Sandbox handler fixtures for tests. Plain JS so it's loaded without transpile.
"use strict";

async function echo(input) {
  return { echoed: input };
}

async function throws() {
  const err = new Error("kaboom");
  err.code = "CUSTOM_CODE";
  throw err;
}

async function sleepForever() {
  return new Promise(() => {
    /* never resolves */
  });
}

// Deliberately crashes the subprocess to prove the parent survives.
async function crashHard() {
  // Invoke a non-exit error path that terminates the child.
  process.nextTick(() => {
    throw new Error("subprocess crashed on purpose");
  });
  return new Promise(() => {});
}

async function doubleInput(input) {
  if (typeof input !== "number") throw new Error("expected number");
  return input * 2;
}

module.exports = {
  echo,
  throws,
  sleepForever,
  crashHard,
  doubleInput,
  default: echo,
};
