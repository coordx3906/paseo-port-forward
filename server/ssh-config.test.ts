import { describe, expect, it, vi } from "vitest";
const { runSsh } = vi.hoisted(() => ({ runSsh: vi.fn() }));
vi.mock("./ssh-command", async (original) => ({ ...await original<typeof import("./ssh-command")>(), runSsh }));
import { configRules, readSshConfiguration } from "./ssh-config";
import { effectiveBind, tunnelKey, tunnelSpec } from "../shared/rules";

describe("SSH static rules", () => {
  it("parses IPv6, omitted and wildcard binds, while retaining unsupported rules individually", () => {
    const rules = configRules([
      "gatewayports yes", "addressfamily any",
      "localforward 3000 [::1]:3000",
      "localforward [localhost]:3001 [::1]:3000",
      "localforward [*]:3002 [localhost]:3000",
      "remoteforward [127.0.0.1]:9223 [::1]:9223",
      "localforward /tmp/a /tmp/b", "remoteforward 1080", "localforward 0 [localhost]:80",
    ].join("\n"));
    expect(rules).toHaveLength(7);
    expect(rules.filter((rule) => rule.error)).toHaveLength(3);
    expect(rules[0]!.tunnel!.bindAddress).toBeNull();
    expect(effectiveBind(rules[0]!.tunnel!)).toBe("*");
    expect(tunnelSpec(rules[0]!.tunnel!)).toBe("*:3000:[::1]:3000");
    expect(effectiveBind(rules[1]!.tunnel!)).toBe("localhost");
    expect(tunnelKey(rules[1]!.tunnel!)).not.toBe(tunnelKey(rules[2]!.tunnel!));
    expect(rules[3]!.tunnel!.direction).toBe("remote");
  });

  it("materializes separate nested jump configs and passes user/port overrides to original evaluation", async () => {
    runSsh.mockImplementation(async (args: string[]) => {
      const host = args.at(-1);
      const output = host === "final" ? "host final\nhostname destination\nproxyjump alice@jump:2222\nlocalforward 3000 [localhost]:3000\n"
        : host === "jump" ? "host jump\nhostname jump-machine\nuser alice\nport 2222\nproxyjump bastion\nremoteforward 9000 [localhost]:9000\n"
        : "host bastion\nhostname entry-machine\n";
      return { code: 0, stdout: output, stderr: "" };
    });
    const config = await readSshConfiguration("final");
    expect(config.text).toContain('Host "final"');
    expect(config.text).toContain('Host "jump"');
    expect(config.text).toContain('Host "bastion"');
    expect(config.text).not.toContain("Host *");
    expect(config.text).not.toMatch(/(?:local|remote)forward /);
    expect(config.text).toContain("ClearAllForwardings no");
    expect(config.rules).toHaveLength(1);
    expect(runSsh).toHaveBeenCalledWith(["-G", "-o", "BatchMode=yes", "-l", "alice", "-p", "2222", "jump"]);
  });
});
