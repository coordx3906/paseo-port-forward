import { spawn } from "node:child_process";

export interface RunResult {
  code: number | null;
  stdout: string;
  stderr: string;
}

export function runSsh(
  args: string[],
  options: { input?: string; timeoutMs?: number } = {},
): Promise<RunResult> {
  return new Promise((resolve) => {
    const child = spawn("ssh", args, { stdio: ["pipe", "pipe", "pipe"], windowsHide: true });
    let stdout = "";
    let stderr = "";
    const timer = setTimeout(() => {
      stderr += "\nssh command timed out";
      child.kill("SIGKILL");
    }, options.timeoutMs ?? 15_000);
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", (error) => {
      clearTimeout(timer);
      resolve({ code: null, stdout, stderr: stderr + error.message });
    });
    child.on("close", (code) => {
      clearTimeout(timer);
      resolve({ code, stdout, stderr });
    });
    child.stdin.on("error", () => {});
    child.stdin.end(options.input ?? "");
  });
}

/** Last meaningful stderr line, for the UI. */
export function sshError(result: RunResult, fallback: string): string {
  const lines = result.stderr
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line && !line.startsWith("Warning: Permanently added"));
  return lines.at(-1) ?? fallback;
}

