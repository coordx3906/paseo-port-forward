/** Windows OpenSSH has no multiplexing: keep a connection per forward. */
import { spawn, type ChildProcess } from "node:child_process";
import { mkdtempSync, writeFileSync, rmSync, rmdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runSsh, sshError } from "./ssh-command";
import { readSshConfiguration, type SshConfiguration } from "./ssh-config";
import { tunnelKey, tunnelSpec, type Tunnel } from "../shared/rules";

const SSH_OPTIONS = [
  "-T", "-o", "BatchMode=yes", "-o", "ConnectTimeout=10",
  "-o", "ServerAliveInterval=15", "-o", "ServerAliveCountMax=3",
  "-o", "ExitOnForwardFailure=yes", "-o", "ControlMaster=no",
  "-o", "ControlPath=none",
  "-o", "ClearAllForwardings=no",
];
const READY = "paseo-port-forward-ready";

// The plugin owns this helper's stdin. EOF (including a plugin crash) kills ssh.
// Keep ssh's stdin open so the remote cat keeps the authenticated session alive.
const WATCHDOG = `
const { spawn } = require('node:child_process');
const ssh = spawn('ssh', JSON.parse(process.argv[1]), {
  stdio: ['pipe', 'inherit', 'inherit'], windowsHide: true
});
ssh.stdin.on('error', () => {});
process.stdin.resume();
process.stdin.on('end', () => ssh.kill());
ssh.on('error', error => { console.error(error.message); process.exitCode = 1; process.stdin.destroy(); });
ssh.on('close', code => { process.exitCode = code ?? 1; process.stdin.destroy(); });
`;

export class WindowsHostSession {
  private connection: ChildProcess | null = null;
  private forwards = new Map<string, ChildProcess>();
  private children = new Set<ChildProcess>();
  private exitListeners = new Set<(error: string) => void>();
  private stopping = false;
  private configDir: string | null = null;
  private forwardExitListeners = new Set<(key: string, error: string) => void>();

  private get options(): string[] {
    return ["-F", join(this.configDir!, "config"), ...SSH_OPTIONS];
  }

  constructor(readonly serverId: string, readonly target: string, private configuration?: SshConfiguration) {}

  onForwardExit(listener: (key: string, error: string) => void): () => void {
    this.forwardExitListeners.add(listener);
    return () => this.forwardExitListeners.delete(listener);
  }

  get running(): boolean {
    return this.connection !== null;
  }

  onExit(listener: (error: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  private launch(extra: string[]): { child: ChildProcess; ready: Promise<void> } {
    const args = [...this.options, ...extra, this.target, `printf '${READY}\\n'; cat >/dev/null`];
    const child = spawn(process.execPath, ["-e", WATCHDOG, JSON.stringify(args)], {
      stdio: ["pipe", "pipe", "pipe"], windowsHide: true,
    });
    this.children.add(child);
    child.stdin?.on("error", () => {});
    let stderr = "";
    let stdout = "";
    let ready = false;
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      stderr = (stderr + chunk).slice(-4000);
    });
    const promise = new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        child.stdin?.end();
        reject(new Error(`Timed out connecting to ${this.target}`));
      }, 20_000);
      child.stdout?.setEncoding("utf8").on("data", (chunk: string) => {
        stdout = (stdout + chunk).slice(-4000);
        if (!ready && stdout.split(/\r?\n/).includes(READY)) {
          ready = true;
          clearTimeout(timer);
          resolve();
        }
      });
      const failed = (error: string) => {
        clearTimeout(timer);
        this.children.delete(child);
        if (!ready) reject(new Error(error));
        else if (!this.stopping && this.connection === child) {
          this.killNow();
          for (const listener of this.exitListeners) listener(error);
        } else if (!this.stopping) {
          for (const [key, forward] of this.forwards) {
            if (forward !== child) continue;
            this.forwards.delete(key);
            for (const listener of this.forwardExitListeners) listener(key, error);
          }
        }
      };
      child.once("error", (error) => failed(error.message));
      child.once("close", () => failed(stderr.trim() || "ssh exited"));
    });
    return { child, ready: promise };
  }

  async start(): Promise<void> {
    if (this.connection) return;
    this.stopping = false;
    const config = this.configuration ?? await readSshConfiguration(this.target);
    if (this.stopping) throw new Error("SSH session was stopped");
    this.configDir = mkdtempSync(join(tmpdir(), "paseo-pf-"));
    writeFileSync(join(this.configDir, "config"), config.text, { mode: 0o600 });
    const pending = this.launch([]);
    this.connection = pending.child;
    try {
      await pending.ready;
    } catch (error) {
      await this.stop();
      throw error;
    }
  }

  async exec(script: string): Promise<string> {
    const result = await runSsh([...this.options, this.target, "sh", "-s"], { input: script });
    if (result.code !== 0 && !result.stdout) {
      throw new Error(sshError(result, `remote command failed (${result.code})`));
    }
    return result.stdout;
  }

  async forward(localPort: number, connectHost: string, remotePort: number): Promise<void> {
    return this.forwardRule(legacyTunnel(localPort, connectHost, remotePort));
  }

  async forwardRule(tunnel: Tunnel): Promise<void> {
    const key = tunnelKey(tunnel);
    if (this.forwards.has(key)) return;
    const pending = this.launch(["-o", `AddressFamily=${tunnel.addressFamily}`,
      tunnel.direction === "local" ? "-L" : "-R", tunnelSpec(tunnel)]);
    this.forwards.set(key, pending.child);
    try {
      await pending.ready;
    } catch (error) {
      if (this.forwards.get(key) === pending.child) this.forwards.delete(key);
      throw error;
    }
    if (this.forwards.get(key) !== pending.child) throw new Error("Forward was cancelled");
  }

  async cancel(localPort: number, connectHost: string, remotePort: number): Promise<void> {
    return this.cancelRule(legacyTunnel(localPort, connectHost, remotePort));
  }

  async cancelRule(tunnel: Tunnel): Promise<void> {
    const key = tunnelKey(tunnel);
    const child = this.forwards.get(key);
    if (!child) return;
    this.forwards.delete(key);
    await this.close(child);
  }

  private close(child: ChildProcess): Promise<void> {
    if (!this.children.has(child)) return Promise.resolve();
    return new Promise((resolve) => {
      child.once("close", () => resolve());
      child.stdin?.end();
    });
  }

  async stop(): Promise<void> {
    this.stopping = true;
    this.connection = null;
    this.forwards.clear();
    await Promise.all([...this.children].map((child) => this.close(child)));
    this.removeConfig();
  }

  killNow(): void {
    this.stopping = true;
    this.connection = null;
    this.forwards.clear();
    for (const child of this.children) child.stdin?.end();
    this.removeConfig();
  }

  private removeConfig(): void {
    if (!this.configDir) return;
    rmSync(join(this.configDir, "config"), { force: true });
    rmdirSync(this.configDir);
    this.configDir = null;
  }
}

function legacyTunnel(localPort: number, connectHost: string, remotePort: number): Tunnel {
  return { direction: "local", bindAddress: "127.0.0.1", listenPort: localPort,
    connectHost: connectHost.replace(/^\[|\]$/g, ""), connectPort: remotePort,
    gatewayPorts: false, addressFamily: "any" };
}
