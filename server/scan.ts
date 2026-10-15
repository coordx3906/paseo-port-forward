/**
 * Port detection on a Linux remote. `SCAN_SCRIPT` runs read-only over the SSH master
 * (`sh -s`) and prints raw facts; every decision about which ports to show is made by
 * `analyzeScan` on this side, where it can be unit-tested.
 */
import type { RemotePort } from "../shared/contracts";

export const SCAN_SCRIPT = String.raw`
PH="$PASEO_HOME"
[ -n "$PH" ] || PH="$HOME/.paseo"
echo "@pidfile"
cat "$PH/paseo.pid" 2>/dev/null
echo
echo "@listen"
for f in /proc/net/tcp /proc/net/tcp6; do
  [ -r "$f" ] && awk -v fam="$(basename "$f")" 'NR>1 && $4=="0A" {print fam, $2, $10}' "$f"
done
echo "@stat"
for s in /proc/[0-9]*/stat; do cat "$s" 2>/dev/null; done | awk '{
  s = $0; i = 0; r = s
  while ((j = index(r, ")")) > 0) { i += j; r = substr(r, j + 1) }
  n = split(substr(s, i + 2), f, " ")
  print substr(s, 1, index(s, " ") - 1), f[2], f[20]
}'
INODES=$(awk 'NR>1 && $4=="0A" {print $10}' /proc/net/tcp /proc/net/tcp6 2>/dev/null | sort -u | tr '\n' ' ')
echo "@owners"
OWNERS=$(ls -l /proc/[0-9]*/fd 2>/dev/null | awk -v want="$INODES" '
  BEGIN { n = split(want, w, " "); for (i = 1; i <= n; i++) W[w[i]] = 1 }
  /^\/proc\/[0-9]+\/fd:$/ { split($0, a, "/"); pid = a[3]; next }
  /socket:\[/ { s = $NF; gsub(/[^0-9]/, "", s); if (s in W) print pid, s }')
echo "$OWNERS"
SUP=$(sed -n 's/.*"pid"[[:space:]]*:[[:space:]]*\([0-9][0-9]*\).*/\1/p' "$PH/paseo.pid" 2>/dev/null)
ROOTS=""
if [ -n "$SUP" ]; then
  ROOTS=$(for s in /proc/[0-9]*/stat; do cat "$s" 2>/dev/null; done | awk -v sup="$SUP" '{
    s = $0; i = 0; r = s
    while ((j = index(r, ")")) > 0) { i += j; r = substr(r, j + 1) }
    split(substr(s, i + 2), f, " ")
    pid = substr(s, 1, index(s, " ") - 1); pp[pid] = f[2]
  } END {
    for (p in pp) if (pp[p] == sup) D[p] = 1
    for (p in pp) if (pp[p] in D) print p
  }')
fi
for pid in $(printf '%s\n%s\n' "$(echo "$OWNERS" | awk '{print $1}')" "$ROOTS" | sort -un); do
  [ -d "/proc/$pid" ] || continue
  echo "@proc $pid"
  echo "cwd $(readlink "/proc/$pid/cwd" 2>/dev/null)"
  echo "comm $(cat "/proc/$pid/comm" 2>/dev/null)"
  printf 'cmd '; tr '\0' ' ' < "/proc/$pid/cmdline" 2>/dev/null | cut -c1-400; echo
  tr '\0' '\n' < "/proc/$pid/environ" 2>/dev/null | grep -E '^PASEO_AGENT_(ID|CWD)=' | sed 's/^/env /'
done
echo "@end"
`;

export interface PidFile {
  pid: number;
  serverId: string | null;
  listen: string | null;
}

interface ListenSocket {
  family: "tcp" | "tcp6";
  address: string;
  port: number;
  inode: string;
}

interface ProcInfo {
  cwd: string | null;
  comm: string;
  cmd: string;
  env: Record<string, string>;
}

export interface RawScan {
  pidFile: PidFile | null;
  listen: ListenSocket[];
  parents: Map<number, number>;
  owners: Map<string, number[]>;
  procs: Map<number, ProcInfo>;
  complete: boolean;
}

export interface ScanResult {
  pidFile: PidFile | null;
  ports: RemotePort[];
}

export function parsePidFile(text: string): PidFile | null {
  const trimmed = text.trim();
  if (!trimmed) return null;
  try {
    const value = JSON.parse(trimmed) as Record<string, unknown>;
    if (typeof value.pid !== "number") return null;
    return {
      pid: value.pid,
      serverId: typeof value.serverId === "string" ? value.serverId : null,
      listen: typeof value.listen === "string" ? value.listen : null,
    };
  } catch {
    return null;
  }
}

function reverseBytes(hex: string): string {
  return hex.match(/../g)?.reverse().join("") ?? "";
}

/** Decode a `/proc/net/tcp{,6}` local address (`0100007F:0BB8`). */
export function decodeProcAddress(
  family: "tcp" | "tcp6",
  value: string,
): { address: string; port: number } | null {
  const [hexAddress, hexPort] = value.split(":");
  if (!hexAddress || !hexPort) return null;
  const port = Number.parseInt(hexPort, 16);
  if (family === "tcp") {
    if (hexAddress.length !== 8) return null;
    const bytes = reverseBytes(hexAddress).match(/../g) ?? [];
    return { address: bytes.map((byte) => Number.parseInt(byte, 16)).join("."), port };
  }
  if (hexAddress.length !== 32) return null;
  const words = hexAddress.match(/.{8}/g) ?? [];
  const bytes = words.map(reverseBytes).join("");
  const groups = (bytes.match(/.{4}/g) ?? []).map((group) => Number.parseInt(group, 16));
  if (groups.slice(0, 5).every((g) => g === 0) && groups[5] === 0xffff) {
    const v4 = bytes.slice(24).match(/../g) ?? [];
    return { address: v4.map((byte) => Number.parseInt(byte, 16)).join("."), port };
  }
  return { address: compressIpv6(groups), port };
}

function compressIpv6(groups: number[]): string {
  let bestStart = -1;
  let bestLength = 0;
  for (let i = 0; i < groups.length; ) {
    if (groups[i] !== 0) {
      i++;
      continue;
    }
    let j = i;
    while (j < groups.length && groups[j] === 0) j++;
    if (j - i > bestLength && j - i > 1) {
      bestStart = i;
      bestLength = j - i;
    }
    i = j;
  }
  const hex = groups.map((g) => g.toString(16));
  if (bestStart < 0) return hex.join(":");
  const head = hex.slice(0, bestStart).join(":");
  const tail = hex.slice(bestStart + bestLength).join(":");
  return `${head}::${tail}`;
}

/** Host the SSH forward should connect to, given the address a remote socket listens on. */
export function connectHostFor(address: string): string {
  if (address === "0.0.0.0" || address.startsWith("127.")) return "127.0.0.1";
  if (address === "::") return "localhost";
  if (address.includes(":")) return `[${address}]`;
  return address;
}

export function parseScanOutput(output: string): RawScan {
  const raw: RawScan = {
    pidFile: null,
    listen: [],
    parents: new Map(),
    owners: new Map(),
    procs: new Map(),
    complete: false,
  };
  let section = "";
  let pidFileText = "";
  let proc: ProcInfo | null = null;
  for (const line of output.split(/\r?\n/)) {
    if (line.startsWith("@")) {
      const [name, arg] = line.slice(1).split(" ");
      section = name ?? "";
      if (section === "proc") {
        proc = { cwd: null, comm: "", cmd: "", env: {} };
        raw.procs.set(Number(arg), proc);
      } else if (section === "end") {
        raw.complete = true;
      }
      continue;
    }
    if (section === "pidfile") {
      pidFileText += line + "\n";
    } else if (section === "listen") {
      const [family, local, inode] = line.trim().split(/\s+/);
      if ((family !== "tcp" && family !== "tcp6") || !local || !inode || inode === "0") continue;
      const decoded = decodeProcAddress(family, local);
      if (decoded) raw.listen.push({ family, inode, ...decoded });
    } else if (section === "stat") {
      const [pid, ppid] = line.trim().split(/\s+/).map(Number);
      if (pid && ppid !== undefined && Number.isFinite(ppid)) raw.parents.set(pid, ppid);
    } else if (section === "owners") {
      const [pid, inode] = line.trim().split(/\s+/);
      if (!pid || !inode) continue;
      const pids = raw.owners.get(inode) ?? [];
      pids.push(Number(pid));
      raw.owners.set(inode, pids);
    } else if (section === "proc" && proc) {
      const space = line.indexOf(" ");
      const key = space < 0 ? line : line.slice(0, space);
      const value = space < 0 ? "" : line.slice(space + 1);
      if (key === "cwd") proc.cwd = value.trim() || null;
      else if (key === "comm") proc.comm = value.trim();
      else if (key === "cmd") proc.cmd = value.trim();
      else if (key === "env") {
        const eq = value.indexOf("=");
        if (eq > 0) proc.env[value.slice(0, eq)] = value.slice(eq + 1);
      }
    }
  }
  raw.pidFile = parsePidFile(pidFileText);
  return raw;
}

/** Ancestors of `pid`, nearest first, stopping at pid 1 or a cycle. */
function ancestors(pid: number, parents: Map<number, number>): number[] {
  const chain: number[] = [];
  const seen = new Set<number>([pid]);
  let current = parents.get(pid);
  while (current !== undefined && current > 0 && !seen.has(current)) {
    chain.push(current);
    seen.add(current);
    current = parents.get(current);
  }
  return chain;
}

function listenPort(listen: string | null): number | null {
  const match = listen?.match(/:(\d+)$/);
  return match ? Number(match[1]) : null;
}

/** Paseo's own processes: the terminal worker, plugin hosts, esbuild. */
function isPaseoInternal(cmd: string): boolean {
  return cmd.includes("/@getpaseo/") || cmd.includes("plugin-process");
}

/**
 * Keep listening sockets owned by processes that descend from the Paseo supervisor,
 * excluding the supervisor, the daemon worker, the daemon's listen port, and anything
 * running under one of the daemon's plugin-host processes.
 */
export function analyzeScan(raw: RawScan): ScanResult {
  const supervisor = raw.pidFile?.pid;
  if (supervisor === undefined) return { pidFile: raw.pidFile, ports: [] };
  const daemonPort = listenPort(raw.pidFile?.listen ?? null);
  const byPort = new Map<number, RemotePort & { family: "tcp" | "tcp6" }>();

  for (const socket of raw.listen) {
    if (socket.port === daemonPort) continue;
    for (const pid of raw.owners.get(socket.inode) ?? []) {
      const chain = ancestors(pid, raw.parents);
      const depth = chain.indexOf(supervisor);
      // depth 0: the parent is the supervisor, so `pid` is the daemon worker itself.
      if (pid === supervisor || depth < 1) continue;
      const branchRoot = chain[depth - 2] ?? pid;
      const info = raw.procs.get(pid);
      const rootInfo = raw.procs.get(branchRoot);
      if (info && isPaseoInternal(info.cmd)) continue;
      if (rootInfo?.cmd.includes("plugin-process")) continue;

      const existing = byPort.get(socket.port);
      if (existing && (existing.family === "tcp" || socket.family === "tcp6")) continue;
      byPort.set(socket.port, {
        family: socket.family,
        port: socket.port,
        bind: socket.address,
        connectHost: connectHostFor(socket.address),
        pid,
        process: info?.comm || info?.cmd.split(" ")[0]?.split("/").pop() || String(pid),
        command: info?.cmd ?? "",
        agentId: info?.env.PASEO_AGENT_ID || null,
        cwd: info?.env.PASEO_AGENT_CWD || info?.cwd || null,
      });
    }
  }

  const ports = [...byPort.values()]
    .map(({ family: _family, ...port }) => port)
    .sort((a, b) => a.port - b.port);
  return { pidFile: raw.pidFile, ports };
}
