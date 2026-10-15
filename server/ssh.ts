/**
 * One OpenSSH ControlMaster per remote host. Uses the system `ssh`, so the user's
 * ~/.ssh/config, agent, jump hosts and keys apply unchanged; `BatchMode=yes` turns any
 * interactive prompt into an error instead of a hang.
 */
import { spawn, type ChildProcess } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdirSync, readdirSync, rmSync } from "node:fs";
import { userInfo } from "node:os";
import { join } from "node:path";

const CONNECT_TIMEOUT_MS = 20_000;
import { WindowsHostSession } from "./windows-ssh";
import { forwardSpec, runSsh, sshError, type RunResult } from "./ssh-command";
export { forwardSpec, runSsh, sshError, type RunResult } from "./ssh-command";

/** Short and outside $TMPDIR: unix socket paths are capped at ~104 bytes on macOS. */
export function runtimeDir(): string {
  const dir = join("/tmp", `paseo-pf-${userInfo().uid}`);
  mkdirSync(dir, { recursive: true, mode: 0o700 });
  return dir;
}

/**
 * Runs `ssh "$@"` and kills it when our stdin pipe closes, so a plugin process that dies
 * without running cleanup (SIGKILL, crash) still takes its master and forwards with it.
 */
const MASTER_WATCHDOG = `
exec 3<&0
ssh "$@" </dev/null &
p=$!
trap 'kill "$p" 2>/dev/null' TERM INT HUP
(read _ <&3; kill "$p" 2>/dev/null) &
w=$!
wait "$p"
s=$?
kill "$w" 2>/dev/null
exit "$s"
`;

/** Close masters a crashed plugin process left behind. */
export async function sweepStaleSockets(): Promise<void> {
  if (process.platform === "win32") return;
  const dir = runtimeDir();
  const sockets = readdirSync(dir).filter((name) => name.endsWith(".sock"));
  await Promise.all(
    sockets.map(async (name) => {
      const path = join(dir, name);
      await runSsh(["-S", path, "-O", "exit", "stale"], { timeoutMs: 5_000 });
      rmSync(path, { force: true });
    }),
  );
}

class UnixHostSession {
  readonly socketPath: string;
  private master: ChildProcess | null = null;
  private stderr = "";
  private stopping = false;
  private exitListeners = new Set<(error: string) => void>();

  constructor(
    readonly serverId: string,
    readonly target: string,
  ) {
    const hash = createHash("sha256").update(`${serverId}\0${target}`).digest("hex").slice(0, 16);
    this.socketPath = join(runtimeDir(), `${hash}.sock`);
  }

  get running(): boolean {
    return this.master !== null;
  }

  onExit(listener: (error: string) => void): () => void {
    this.exitListeners.add(listener);
    return () => this.exitListeners.delete(listener);
  }

  /** Start the master and resolve once it accepts mux commands. */
  async start(): Promise<void> {
    if (this.master) return;
    this.stopping = false;
    this.stderr = "";
    rmSync(this.socketPath, { force: true });
    const child = spawn(
      "sh",
      [
        "-c",
        MASTER_WATCHDOG,
        "sh",
        "-M",
        "-S",
        this.socketPath,
        "-N",
        "-o",
        "ControlPersist=no",
        "-o",
        "BatchMode=yes",
        "-o",
        "ConnectTimeout=10",
        "-o",
        "ServerAliveInterval=15",
        "-o",
        "ServerAliveCountMax=3",
        "-o",
        "ExitOnForwardFailure=yes",
        this.target,
      ],
      { stdio: ["pipe", "ignore", "pipe"] },
    );
    this.master = child;
    child.stdin?.on("error", () => {});
    child.stderr?.setEncoding("utf8").on("data", (chunk: string) => {
      this.stderr = (this.stderr + chunk).slice(-4000);
    });
    const exited = new Promise<string>((resolve) => {
      child.on("error", (error) => resolve(error.message));
      child.on("exit", () => resolve(this.lastError("ssh exited")));
    });
    void exited.then((error) => {
      if (this.master !== child) return;
      this.master = null;
      rmSync(this.socketPath, { force: true });
      if (!this.stopping) for (const listener of this.exitListeners) listener(error);
    });

    const deadline = Date.now() + CONNECT_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const outcome = await Promise.race([
        exited.then((error) => ({ exited: error })),
        new Promise<null>((resolve) => setTimeout(() => resolve(null), 250)),
      ]);
      if (outcome) throw new Error(outcome.exited);
      const check = await this.control("check");
      if (check.code === 0) return;
    }
    await this.stop();
    throw new Error(`Timed out connecting to ${this.target}`);
  }

  private lastError(fallback: string): string {
    return sshError({ code: null, stdout: "", stderr: this.stderr }, fallback);
  }

  private control(command: string, extra: string[] = []): Promise<RunResult> {
    return runSsh(["-S", this.socketPath, "-O", command, ...extra, this.target], {
      timeoutMs: 5_000,
    });
  }

  /** Run a shell script on the remote through the master connection. */
  async exec(script: string): Promise<string> {
    const result = await runSsh(
      ["-S", this.socketPath, "-o", "BatchMode=yes", this.target, "sh", "-s"],
      { input: script },
    );
    if (result.code !== 0 && !result.stdout) {
      throw new Error(sshError(result, `remote command failed (${result.code})`));
    }
    return result.stdout;
  }

  async forward(localPort: number, connectHost: string, remotePort: number): Promise<void> {
    const result = await this.control("forward", [
      "-L",
      forwardSpec(localPort, connectHost, remotePort),
    ]);
    if (result.code !== 0) throw new Error(sshError(result, "ssh refused the forward"));
  }

  async cancel(localPort: number, connectHost: string, remotePort: number): Promise<void> {
    const result = await this.control("cancel", [
      "-L",
      forwardSpec(localPort, connectHost, remotePort),
    ]);
    if (result.code !== 0) throw new Error(sshError(result, "ssh refused to cancel the forward"));
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const child = this.master;
    if (!child) return;
    await this.control("exit");
    if (this.master === child) {
      child.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timer = setTimeout(() => {
          child.kill("SIGKILL");
          resolve();
        }, 2_000);
        child.once("exit", () => {
          clearTimeout(timer);
          resolve();
        });
      });
    }
    this.master = null;
    rmSync(this.socketPath, { force: true });
  }

  /** Synchronous last resort for process exit. */
  killNow(): void {
    this.stopping = true;
    this.master?.kill("SIGTERM");
    this.master = null;
    rmSync(this.socketPath, { force: true });
  }
}

export const HostSession = process.platform === "win32" ? WindowsHostSession : UnixHostSession;
export type HostSession = UnixHostSession | WindowsHostSession;
