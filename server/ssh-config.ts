import { connectionConfig } from "./windows-ssh-config";
import { runSsh, sshError } from "./ssh-command";

export interface SshConfiguration { text: string }

export function configValue(output: string, key: string): string | undefined {
  return output.split(/\r?\n/).find((line) => line.startsWith(key + " "))?.slice(key.length + 1);
}

/** Evaluate every jump using the original config; never apply the destination's Host * to it. */
export async function readSshConfiguration(target: string, sourceFile?: string): Promise<SshConfiguration> {
  const blocks = new Map<string, string>();
  async function read(host: string, overrides: string[] = []): Promise<void> {
    if (blocks.has(host)) return;
    const result = await runSsh(["-G", ...(sourceFile ? ["-F", sourceFile] : []), "-o", "BatchMode=yes", ...overrides, host]);
    if (result.code !== 0) throw new Error(sshError(result, "Could not read SSH configuration"));
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
  return { text };
}
