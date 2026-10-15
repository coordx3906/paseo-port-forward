import { describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { connectionConfig } from "./windows-ssh-config";

describe("effective Windows SSH configuration", () => {
  it.each([
    ["GREETING=hello world"],
    ["GREETING=hello world", "OTHER=x y"],
    ['GREETING=hello "world"', "PATH_VALUE=C:\\Test Folder"],
  ])("round-trips SetEnv assignments through OpenSSH: %j", (...assignments) => {
    const original = spawnSync("ssh", ["-G", "-F", "none", "-l", "tester",
      "-o", `SetEnv=${assignments.map((value) => JSON.stringify(value)).join(" ")}`,
      "example.invalid"], { encoding: "utf8", windowsHide: true });
    expect(original.status, original.stderr).toBe(0);
    const dir = mkdtempSync(join(tmpdir(), "paseo-config-test-"));
    try {
      const path = join(dir, "config");
      writeFileSync(path, connectionConfig(original.stdout), { mode: 0o600 });
      const restored = spawnSync("ssh", ["-G", "-F", path, "example.invalid"],
        { encoding: "utf8", windowsHide: true });
      expect(restored.status, restored.stderr).toBe(0);
      expect(restored.stdout.split(/\r?\n/).filter((line) => line.startsWith("setenv ")))
        .toEqual(assignments.map((value) => `setenv ${value}`));
    } finally {
      rmSync(dir, { recursive: true });
    }
  });

  it("removes inherited forwards and preserves connection settings and spaced paths", () => {
    const config = connectionConfig([
      "host test-host", "hostname example.com", "port 2222", "user tester",
      "localforward 3000 localhost:3000", "remoteforward 9223 localhost:9223",
      "dynamicforward 1080", "identityfile C:\\Users\\Test User\\.ssh\\key",
      "userknownhostsfile C:\\Users\\Test User/.ssh/known_hosts C:\\Users\\Test User/.ssh/known_hosts2",
      "proxycommand ssh jump-host -W %h:%p",
    ].join("\r\n"));
    expect(config).not.toMatch(/(?:local|remote|dynamic)forward/);
    expect(config).toContain('identityfile "C:/Users/Test User/.ssh/key"');
    expect(config).toContain('userknownhostsfile "C:/Users/Test User/.ssh/known_hosts" "C:/Users/Test User/.ssh/known_hosts2"');
    expect(config).toContain("proxycommand ssh jump-host -W %h:%p");
    expect(config).toContain("port 2222");
  });
});
