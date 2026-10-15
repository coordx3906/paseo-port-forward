import { createHash } from "node:crypto";
import { connectionConfig } from "./windows-ssh-config";
import { runSsh, sshError } from "./ssh-command";
import { TunnelSchema, type Tunnel } from "../shared/rules";

export interface ConfigRule { id: string; tunnel: Tunnel | null; raw: string; error: string | null }
export interface SshConfiguration { text: string; rules: ConfigRule[]; fingerprint: string }

export function configValue(output: string, key: string): string | undefined {
  return output.split(/\r?\n/).find((line) => line.startsWith(key + " "))?.slice(key.length + 1);
}

function endpoint(text: string): { host: string | null; port: number } {
  if (/^\d+$/.test(text)) return { host: null, port: Number(text) };
  const match = text.match(/^(?:\[([^\]]*)\]|([^:]*)):(\d+)$/);
  if (!match) throw new Error("Only static TCP forwards are supported");
  return { host: match[1] ?? match[2]!, port: Number(match[3]) };
}

export function configRules(output: string): ConfigRule[] {
  const rules = new Map<string, ConfigRule>();
  for (const raw of output.split(/\r?\n/)) {
    const match = raw.match(/^(localforward|remoteforward)\s+(.+)$/);
    if (!match) continue;
    const id = createHash("sha256").update(raw).digest("hex").slice(0, 20);
    try {
      const parts = match[2]!.trim().split(/\s+/);
      if (parts.length !== 2) throw new Error("Only static TCP forwards are supported");
      const listen = endpoint(parts[0]!);
      const connect = endpoint(parts[1]!);
      if (!connect.host) throw new Error("Only static TCP forwards are supported");
      const tunnel = TunnelSchema.parse({
        direction: match[1] === "localforward" ? "local" : "remote",
        bindAddress: listen.host, listenPort: listen.port,
        connectHost: connect.host, connectPort: connect.port,
        gatewayPorts: configValue(output, "gatewayports") === "yes",
        addressFamily: configValue(output, "addressfamily") ?? "any",
      });
      rules.set(id, { id, tunnel, raw, error: null });
    } catch {
      rules.set(id, { id, tunnel: null, raw, error: "Unsupported rule: static TCP ports 1–65535 are required" });
    }
  }
  return [...rules.values()];
}

/** Evaluate every jump using the original config; never apply the destination's Host * to it. */
export async function readSshConfiguration(target: string, sourceFile?: string): Promise<SshConfiguration> {
  const blocks = new Map<string, string>();
  let root = "";
  async function read(host: string, overrides: string[] = []): Promise<void> {
    if (blocks.has(host)) return;
    const result = await runSsh(["-G", ...(sourceFile ? ["-F", sourceFile] : []), "-o", "BatchMode=yes", ...overrides, host]);
    if (result.code !== 0) throw new Error(sshError(result, "Could not read SSH configuration"));
    if (!root) root = result.stdout;
    blocks.set(host, connectionConfig(result.stdout, configValue(result.stdout, "host") ?? host.replace(/^.*@/, "")));
    const jumps = configValue(result.stdout, "proxyjump");
    if (jumps && jumps !== "none") {
      for (const jump of jumps.split(",")) {
        const match = jump.match(/^(?:([^@]+)@)?(\[[^\]]+\]|[^:]+)(?::(\d+))?$/);
        if (!match) throw new Error(`Invalid ProxyJump target: ${jump}`);
        await read(match[2]!.replace(/^\[|\]$/g, ""), [
          ...(match[1] ? ["-l", match[1]] : []), ...(match[3] ? ["-p", match[3]] : []),
        ]);
      }
    }
  }
  await read(target);
  const text = [...blocks.values()].join("\n");
  return { text, rules: configRules(root), fingerprint: createHash("sha256").update(text).digest("hex") };
}
