import { afterEach, describe, expect, test } from "bun:test";
import { homedir } from "node:os";
import { join } from "node:path";
import { expandUserPath, getConfigDir } from "../../src/config";

const previousEasyProxyHome = process.env.EASYPROXY_HOME;

afterEach(() => {
  if (previousEasyProxyHome === undefined) delete process.env.EASYPROXY_HOME;
  else process.env.EASYPROXY_HOME = previousEasyProxyHome;
});

describe("expandUserPath", () => {
  test("expands ~ and leading ~/ or ~\\ to the home directory", () => {
    expect(expandUserPath("~")).toBe(homedir());
    expect(expandUserPath("~/custom/dir")).toBe(join(homedir(), "custom/dir"));
    expect(expandUserPath("~\\custom\\dir")).toBe(join(homedir(), "custom\\dir"));
  });

  test("leaves ~user, absolute, relative, and %VAR%/$VAR paths untouched", () => {
    expect(expandUserPath("~other/dir")).toBe("~other/dir");
    expect(expandUserPath("/absolute/dir")).toBe("/absolute/dir");
    expect(expandUserPath("relative/dir")).toBe("relative/dir");
    expect(expandUserPath("%USERPROFILE%\\dir")).toBe("%USERPROFILE%\\dir");
    expect(expandUserPath("$HOME/dir")).toBe("$HOME/dir");
  });
});

describe("EASYPROXY_HOME tilde expansion", () => {
  test("getConfigDir honors EASYPROXY_HOME=~/...", () => {
    process.env.EASYPROXY_HOME = "~/.epx-tilde-test";
    expect(getConfigDir()).toBe(join(homedir(), ".epx-tilde-test"));
  });
});
