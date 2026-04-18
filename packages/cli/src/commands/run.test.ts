import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { openBrowser } from "./run.js";

/**
 * openBrowser is tested in isolation — the `spawn` import is replaced
 * via vi.mock so we don't actually launch a browser. The test only
 * verifies the platform-correct command + args are selected and that
 * the spawn call is detached + unref'd.
 */

const spawnMock = vi.fn();
const unrefMock = vi.fn();
const onMock = vi.fn();

vi.mock("node:child_process", () => ({
  spawn: (...args: unknown[]) => {
    spawnMock(...args);
    return {
      on: onMock,
      unref: unrefMock,
    };
  },
}));

describe("openBrowser", () => {
  const origPlatform = process.platform;
  const origBrowser = process.env.CHORUS_BROWSER;

  beforeEach(() => {
    spawnMock.mockReset();
    unrefMock.mockReset();
    onMock.mockReset();
    delete process.env.CHORUS_BROWSER;
  });
  afterEach(() => {
    Object.defineProperty(process, "platform", { value: origPlatform });
    if (origBrowser === undefined) delete process.env.CHORUS_BROWSER;
    else process.env.CHORUS_BROWSER = origBrowser;
  });

  function setPlatform(p: NodeJS.Platform): void {
    Object.defineProperty(process, "platform", { value: p });
  }

  it("on win32 spawns cmd /c start \"\" <url>", () => {
    setPlatform("win32");
    openBrowser("http://127.0.0.1:3710");
    expect(spawnMock).toHaveBeenCalledTimes(1);
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("cmd");
    expect(args).toEqual(["/c", "start", "", "http://127.0.0.1:3710"]);
    expect(unrefMock).toHaveBeenCalled();
  });

  it("on darwin spawns `open <url>`", () => {
    setPlatform("darwin");
    openBrowser("http://localhost:3710");
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("open");
    expect(args).toEqual(["http://localhost:3710"]);
  });

  it("on linux spawns `xdg-open <url>`", () => {
    setPlatform("linux");
    openBrowser("http://localhost:3710");
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("xdg-open");
    expect(args).toEqual(["http://localhost:3710"]);
  });

  it("honors CHORUS_BROWSER override", () => {
    setPlatform("linux");
    process.env.CHORUS_BROWSER = "/usr/bin/firefox";
    openBrowser("http://localhost:3710");
    const [cmd, args] = spawnMock.mock.calls[0];
    expect(cmd).toBe("/usr/bin/firefox");
    expect(args).toEqual(["http://localhost:3710"]);
  });

  it("spawns detached and unref's the child", () => {
    setPlatform("linux");
    openBrowser("http://localhost:3710");
    const [, , opts] = spawnMock.mock.calls[0];
    expect(opts.detached).toBe(true);
    expect(opts.stdio).toBe("ignore");
    expect(opts.shell).toBe(false);
    expect(unrefMock).toHaveBeenCalled();
  });
});
