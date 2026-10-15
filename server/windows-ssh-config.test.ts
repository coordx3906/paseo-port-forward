import { describe, expect, it } from "vitest";
import { connectionConfig } from "./windows-ssh-config";

describe("effective Windows SSH configuration", () => {
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
