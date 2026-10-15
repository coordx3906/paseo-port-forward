import type { Forward, PortsState, RemotePort, SshStatus } from "../shared/contracts";
import { defaultPortSettings, type PortSettings } from "../shared/settings";
import { effectiveBind, tunnelKey, type Rule, type Tunnel } from "../shared/rules";
import { isLocalPortFree } from "./local-port";
import { analyzeScan, parsePidFile, parseScanOutput, SCAN_SCRIPT } from "./scan";
import { HostSession } from "./ssh";
import { readSshConfiguration, type SshConfiguration } from "./ssh-config";

const IDENTITY_SCRIPT = 'PH="$PASEO_HOME"; [ -n "$PH" ] || PH="$HOME/.paseo"; cat "$PH/paseo.pid"';

interface Instance {
  tunnel: Tunnel;
  refs: Map<string, string>;
  status: "connecting" | "active" | "error";
  error: string | null;
  portConflict: boolean;
}
interface HostEntry {
  serverId: string;
  session: HostSession | null;
  configuration: SshConfiguration | null;
  ssh: SshStatus;
  ports: RemotePort[];
  rules: Map<string, Rule>;
  instances: Map<string, Instance>;
  detected: Set<number>;
  suppressed: Set<number>;
  scannedAt: number | null;
  scanError: string | null;
  configError: string | null;
  connecting: Promise<void> | null;
  scanning: Promise<void> | null;
  syncing: Promise<void> | null;
  closing: Set<Promise<void>>;
  revision: number;
  generation: number;
  reconnectTimer: NodeJS.Timeout | null;
  backoffMs: number;
  lastTouched: number;
}

export class PortManager {
  private hosts = new Map<string, HostEntry>();
  private settings = defaultPortSettings();
  private disposed = false;
  private timer: NodeJS.Timeout;

  constructor(private readonly log: (message: string) => void = console.log) {
    this.timer = setInterval(() => void this.tick(), 5_000);
  }

  applySettings(settings: PortSettings): void {
    this.settings = settings;
    clearInterval(this.timer);
    this.timer = setInterval(() => void this.tick(), settings.pollSeconds * 1000);
    for (const id of new Set([...this.hosts.keys(), ...Object.keys(settings.targets)])) {
      const entry = this.entry(id);
      const target = settings.targets[id]?.trim() || null;
      if (target !== entry.ssh.target) {
        entry.ssh.target = target;
        entry.configuration = null;
        entry.detected.clear();
        entry.suppressed.clear();
        entry.ports = [];
        this.updateRules(entry);
        void this.closeSession(entry).then(() => this.synchronize(entry)).catch((error) => this.hostError(entry, error));
      } else {
        this.updateRules(entry);
        void this.synchronize(entry).catch((error) => this.hostError(entry, error));
      }
    }
  }

  private entry(serverId: string): HostEntry {
    let entry = this.hosts.get(serverId);
    if (!entry) {
      const target = this.settings.targets[serverId]?.trim() || null;
      entry = {
        serverId, session: null, configuration: null,
        ssh: { state: target ? "idle" : "unmapped", target, error: null, remoteServerId: null },
        ports: [], rules: new Map(), instances: new Map(), detected: new Set(), suppressed: new Set(),
        scannedAt: null, scanError: null, configError: null,
        connecting: null, scanning: null, syncing: null, closing: new Set(), revision: 0, generation: 0,
        reconnectTimer: null, backoffMs: 1000, lastTouched: Date.now(),
      };
      this.hosts.set(serverId, entry);
    }
    return entry;
  }

  private hostError(entry: HostEntry, error: unknown): void {
    if (this.disposed) return;
    entry.ssh.state = entry.ssh.target ? "error" : "unmapped";
    entry.ssh.error = message(error);
    for (const rule of entry.rules.values()) {
      if (rule.enabled && rule.tunnel) { rule.status = "error"; rule.error = message(error); }
    }
    this.scheduleReconnect(entry);
  }

  private ensureConnected(entry: HostEntry): Promise<void> {
    if (entry.connecting) return entry.connecting;
    if (entry.session?.running && entry.ssh.state === "connected") return Promise.resolve();
    const target = entry.ssh.target;
    const generation = entry.generation;
    if (!target) return Promise.reject(new Error("No SSH target configured"));
    entry.ssh.state = "connecting";
    entry.ssh.error = null;
    const pending = (async () => {
      const configuration = entry.configuration ?? await readSshConfiguration(target);
      if (this.disposed || entry.ssh.target !== target || entry.generation !== generation) throw new Error("SSH target changed");
      const session = new HostSession(entry.serverId, target, configuration);
      entry.session = session;
      try {
        await session.start();
        const pidFile = parsePidFile(await session.exec(IDENTITY_SCRIPT));
        if (pidFile?.serverId !== entry.serverId) throw new Error(
          `SSH target reports Paseo host ${pidFile?.serverId ?? "unknown"}, expected ${entry.serverId}`,
        );
        if (this.disposed || entry.session !== session || entry.ssh.target !== target || entry.generation !== generation) throw new Error("SSH session was stopped");
        entry.configuration = configuration;
        entry.configError = null;
        entry.ssh = { ...entry.ssh, state: "connected", error: null, remoteServerId: pidFile.serverId };
        entry.backoffMs = 1000;
        session.onExit((error) => {
          if (entry.session !== session || this.disposed) return;
          entry.session = null;
          entry.instances.clear();
          this.hostError(entry, `Connection lost: ${error}`);
        });
        session.onForwardExit((key, error) => {
          const instance = entry.instances.get(key);
          if (!instance || entry.session !== session) return;
          instance.status = "error";
          instance.error = error;
          this.projectInstances(entry);
        });
        this.updateRules(entry);
        for (const rule of entry.rules.values()) if (rule.tunnel) { rule.status = "stopped"; rule.error = null; rule.portConflict = false; }
      } catch (error) {
        if (entry.session === session) entry.session = null;
        await session.stop();
        throw error;
      }
    })();
    entry.connecting = pending.finally(() => { entry.connecting = null; });
    return entry.connecting;
  }

  private scheduleReconnect(entry: HostEntry): void {
    if (this.disposed || entry.reconnectTimer || !entry.ssh.target) return;
    if (entry.configuration && ![...entry.rules.values()].some((rule) => rule.enabled) && !this.settings.autoForward) return;
    const delay = entry.backoffMs;
    entry.backoffMs = Math.min(delay * 2, 30_000);
    entry.reconnectTimer = setTimeout(() => {
      entry.reconnectTimer = null;
      void this.synchronize(entry).catch((error) => this.hostError(entry, error));
    }, delay);
  }

  private updateRules(entry: HostEntry): void {
    const rules = new Map<string, Rule>();
    const add = (rule: Rule) => {
      const previous = entry.rules.get(rule.id);
      if (previous && signature(previous) === signature(rule)) {
        rule.actualPort = previous.actualPort;
        rule.status = rule.enabled ? previous.status : "stopped";
        rule.error = previous.error;
        rule.portConflict = previous.portConflict;
      }
      rules.set(rule.id, rule);
    };
    for (const manual of this.settings.manualRules.filter((rule) => rule.serverId === entry.serverId)) {
      add(makeRule(manual.id, "manual", manual.name || `Port ${manual.remotePort}`, manual.enabled,
        localTunnel(manual.localPort ?? manual.remotePort, "127.0.0.1", manual.remotePort), manual.localPort === null));
    }
    for (const config of entry.configuration?.rules ?? []) {
      const id = `ssh:${entry.serverId}:${entry.ssh.target}:${config.id}`;
      const override = this.settings.ruleOverrides[id];
      const tunnel = config.tunnel ? { ...config.tunnel, listenPort: override?.listenPort ?? config.tunnel.listenPort } : null;
      const rule = makeRule(id, "ssh", "SSH config", override?.enabled ?? true, tunnel, false);
      rule.requestedPort = config.tunnel?.listenPort ?? null;
      rule.raw = config.raw;
      rule.error = config.error;
      rule.status = config.error ? "error" : rule.status;
      add(rule);
    }
    for (const port of entry.ports) {
      const auto = this.settings.autoForward && !this.settings.ignorePorts.includes(port.port);
      const enabled = (entry.detected.has(port.port) || auto) && !entry.suppressed.has(port.port);
      add(makeRule(`detected:${entry.serverId}:${port.port}`, "detected", port.process, enabled,
        localTunnel(port.port, port.connectHost.replace(/^\[|\]$/g, ""), port.port), true));
    }
    entry.rules = rules;
    entry.revision++;
    // Detach immediately, including while a forward is waiting for readiness.
    for (const [key, instance] of entry.instances) {
      for (const [id, expected] of instance.refs) {
        const rule = rules.get(id);
        if (!rule?.enabled || signature(rule) !== expected) instance.refs.delete(id);
      }
      if (!instance.refs.size) {
        entry.instances.delete(key);
        this.cancelInstance(entry, instance);
      }
    }
    this.projectInstances(entry);
  }

  private cancelInstance(entry: HostEntry, instance: Instance): void {
    const session = entry.session;
    if (!session) return;
    const closing = session.cancelRule(instance.tunnel).catch((error) => this.log(`[port-forward] cancel: ${message(error)}`));
    entry.closing.add(closing);
    void closing.finally(() => entry.closing.delete(closing));
  }

  private projectInstances(entry: HostEntry): void {
    for (const rule of entry.rules.values()) {
      rule.sharedWith = [];
      if (!rule.enabled) { rule.status = "stopped"; rule.error = null; rule.actualPort = null; rule.portConflict = false; }
      const own = [...entry.instances.values()].find((instance) => instance.refs.has(rule.id));
      if (own) {
        rule.actualPort = own.tunnel.listenPort;
        rule.status = own.status;
        rule.error = own.error;
        rule.portConflict = own.portConflict;
        rule.sharedWith = [...own.refs.keys()].filter((id) => id !== rule.id);
      } else if (!rule.enabled && rule.tunnel) {
        const shared = entry.instances.get(tunnelKey(rule.tunnel));
        if (shared?.status === "active") rule.sharedWith = [...shared.refs.keys()];
      }
    }
  }

  private synchronize(entry: HostEntry): Promise<void> {
    if (entry.syncing) return entry.syncing;
    const pending = (async () => {
      if (this.disposed || !entry.ssh.target) return;
      await this.ensureConnected(entry);
      let revision: number;
      do {
        revision = entry.revision;
        await Promise.all([...entry.closing]);
        for (const rule of entry.rules.values()) {
          if (!rule.enabled || !rule.tunnel || rule.status === "error") continue;
          if ([...entry.instances.values()].some((instance) => instance.refs.has(rule.id))) continue;
          await this.startRule(entry, rule);
        }
      } while (revision !== entry.revision && !this.disposed && entry.session?.running);
      this.projectInstances(entry);
    })();
    entry.syncing = pending.finally(() => { entry.syncing = null; });
    return entry.syncing;
  }

  private async startRule(entry: HostEntry, rule: Rule): Promise<void> {
    const session = entry.session;
    const requested = rule.tunnel!;
    let port = rule.actualPort ?? requested.listenPort;
    if (rule.automatic && port < 1024) port += 1024;
    const limit = Math.min(port + (rule.automatic ? 100 : 0), 65535);
    for (; port <= limit; port++) {
      if (entry.rules.get(rule.id) !== rule || !rule.enabled || entry.session !== session || !session?.running) return;
      const tunnel = { ...requested, listenPort: port };
      const key = tunnelKey(tunnel);
      const shared = entry.instances.get(key);
      if (shared) {
        shared.refs.set(rule.id, signature(rule));
        this.projectInstances(entry);
        return;
      }
      if (rule.automatic && !await isLocalPortFree(port)) continue;
      const instance: Instance = { tunnel, refs: new Map([[rule.id, signature(rule)]]), status: "connecting", error: null, portConflict: false };
      entry.instances.set(key, instance);
      rule.status = "connecting";
      rule.actualPort = port;
      try {
        await session.forwardRule(tunnel);
        if (entry.instances.get(key) !== instance || !instance.refs.size || entry.session !== session) {
          await session.cancelRule(tunnel);
          return;
        }
        instance.status = "active";
        this.projectInstances(entry);
        return;
      } catch (error) {
        if (entry.instances.get(key) !== instance) return;
        entry.instances.delete(key);
        const conflict = /address already in use|only one usage of each socket address/i.test(message(error));
        if (rule.automatic && conflict) continue;
        for (const id of instance.refs.keys()) {
          const current = entry.rules.get(id);
          if (current?.enabled) { current.status = "error"; current.error = message(error); current.portConflict = conflict; }
        }
        return;
      }
    }
    rule.status = "error";
    rule.error = "No available local port within the next 100 ports";
    rule.portConflict = true;
  }

  private async scan(entry: HostEntry): Promise<void> {
    if (entry.scanning) return entry.scanning;
    if (entry.scannedAt && Date.now() - entry.scannedAt < (entry.scanError ? 5000 : 1500)) return;
    const pending = (async () => {
      try {
        await this.ensureConnected(entry);
        const session = entry.session!;
        const raw = parseScanOutput(await session.exec(SCAN_SCRIPT));
        if (entry.session !== session) return;
        if (!raw.complete) throw new Error("Port scan output was truncated");
        const result = analyzeScan(raw);
        if (result.pidFile?.serverId !== entry.serverId) throw new Error("Remote Paseo identity changed");
        entry.ports = result.ports;
        entry.scanError = null;
        const open = new Set(entry.ports.map((port) => port.port));
        for (const port of entry.detected) if (!open.has(port)) entry.detected.delete(port);
        for (const port of entry.suppressed) if (!open.has(port)) entry.suppressed.delete(port);
        this.updateRules(entry);
        await this.synchronize(entry);
      } catch (error) { entry.scanError = message(error); }
      finally { entry.scannedAt = Date.now(); }
    })();
    entry.scanning = pending.finally(() => { entry.scanning = null; });
    return entry.scanning;
  }

  async state(serverId: string): Promise<PortsState> {
    const entry = this.entry(serverId);
    entry.lastTouched = Date.now();
    if (entry.ssh.target) {
      if (entry.scannedAt === null) await this.scan(entry);
      else void this.scan(entry);
    }
    return snapshot(entry);
  }

  async forward(serverId: string, remotePort: number, _auto = false): Promise<Forward> {
    const entry = this.entry(serverId);
    entry.detected.add(remotePort);
    entry.suppressed.delete(remotePort);
    this.updateRules(entry);
    const id = `detected:${serverId}:${remotePort}`;
    await this.retryRule(serverId, id);
    const rule = entry.rules.get(id);
    if (!rule?.tunnel) throw new Error("Port is no longer detected; use Add port instead");
    return { serverId, remotePort, connectHost: rule.tunnel.connectHost, localPort: rule.actualPort ?? rule.tunnel.listenPort,
      status: rule.status === "active" ? "active" : "error", error: rule.error, auto: false };
  }

  async unforward(serverId: string, remotePort: number): Promise<boolean> {
    const entry = this.entry(serverId);
    entry.detected.delete(remotePort);
    entry.suppressed.add(remotePort);
    this.updateRules(entry);
    await Promise.all([...entry.closing]);
    return true;
  }

  async retryRule(serverId: string, ruleId: string): Promise<PortsState> {
    const entry = this.entry(serverId);
    const rule = entry.rules.get(ruleId);
    if (!rule) throw new Error("Rule no longer exists; refresh the list");
    if (rule.enabled && rule.tunnel) {
      const existing = [...entry.instances.entries()].find(([, instance]) => instance.refs.has(ruleId));
      if (existing?.[1].status === "error") {
        entry.instances.delete(existing[0]);
        for (const id of existing[1].refs.keys()) {
          const shared = entry.rules.get(id);
          if (shared) { shared.status = "stopped"; shared.error = null; }
        }
      }
      rule.status = "stopped";
      rule.error = null;
      rule.portConflict = false;
    }
    await this.synchronize(entry);
    return snapshot(entry);
  }

  async availablePort(serverId: string, ruleId: string): Promise<number> {
    const rule = this.entry(serverId).rules.get(ruleId);
    if (!rule?.tunnel || rule.tunnel.direction !== "local" || !rule.portConflict) throw new Error("A local port conflict is required");
    const tunnel = rule.tunnel;
    const bind = effectiveBind(tunnel);
    const hosts = bind === "*" || bind === "" ? ["0.0.0.0", "::"] : bind === "localhost" ? ["127.0.0.1", "::1"] : [bind];
    const probes = hosts.filter((host) => tunnel.addressFamily === "any" || (host.includes(":") ? tunnel.addressFamily === "inet6" : tunnel.addressFamily === "inet"));
    for (let port = Math.max(tunnel.listenPort, 1024); port <= Math.min(Math.max(tunnel.listenPort, 1024) + 100, 65535); port++) {
      if ((await Promise.all(probes.map((host) => isLocalPortFree(port, host)))).every(Boolean)) return port;
    }
    throw new Error("No available local port within the next 100 ports");
  }

  async refreshConfig(serverId: string): Promise<PortsState> {
    const entry = this.entry(serverId);
    if (!entry.ssh.target) throw new Error("No SSH target configured");
    const target = entry.ssh.target;
    try {
      const configuration = await readSshConfiguration(target);
      if (entry.ssh.target !== target || this.disposed) throw new Error("SSH target changed");
      if (configuration.fingerprint !== entry.configuration?.fingerprint) await this.closeSession(entry);
      entry.configuration = configuration;
      entry.configError = null;
      this.updateRules(entry);
      await this.synchronize(entry);
    } catch (error) { entry.configError = message(error); }
    return snapshot(entry);
  }

  async testConnection(serverId: string, target?: string): Promise<{ ok: boolean; remoteServerId: string | null; error: string | null }> {
    const resolved = target?.trim() || this.settings.targets[serverId];
    if (!resolved) return { ok: false, remoteServerId: null, error: "No SSH target configured" };
    const session = new HostSession(`${serverId}-test`, resolved);
    try {
      await session.start();
      const remoteServerId = parsePidFile(await session.exec(IDENTITY_SCRIPT))?.serverId ?? null;
      return { ok: remoteServerId === serverId, remoteServerId,
        error: remoteServerId === serverId ? null : `Connected to Paseo host ${remoteServerId}, expected ${serverId}` };
    } catch (error) { return { ok: false, remoteServerId: null, error: message(error) }; }
    finally { await session.stop(); }
  }

  private async tick(): Promise<void> {
    for (const entry of this.hosts.values()) {
      if (!entry.ssh.target || entry.reconnectTimer || !entry.session?.running) continue;
      if (![...entry.rules.values()].some((rule) => rule.enabled) && !this.settings.autoForward && Date.now() - entry.lastTouched > 120_000) {
        await this.closeSession(entry);
      } else await this.scan(entry);
    }
  }

  private async closeSession(entry: HostEntry): Promise<void> {
    entry.generation++;
    entry.revision++;
    if (entry.reconnectTimer) clearTimeout(entry.reconnectTimer);
    entry.reconnectTimer = null;
    const session = entry.session;
    entry.session = null;
    entry.instances.clear();
    entry.ssh.state = entry.ssh.target ? "idle" : "unmapped";
    entry.ssh.remoteServerId = null;
    entry.scannedAt = null;
    for (const rule of entry.rules.values()) if (rule.tunnel) { rule.status = "stopped"; rule.error = null; }
    if (session) await session.stop();
    await Promise.allSettled([entry.syncing, entry.connecting].filter(Boolean));
  }

  async dispose(): Promise<void> {
    this.disposed = true;
    clearInterval(this.timer);
    await Promise.all([...this.hosts.values()].map((entry) => this.closeSession(entry)));
    this.hosts.clear();
  }

  killAll(): void {
    this.disposed = true;
    clearInterval(this.timer);
    for (const entry of this.hosts.values()) entry.session?.killNow();
  }
}

function localTunnel(port: number, host: string, remote: number): Tunnel {
  return { direction: "local", bindAddress: "127.0.0.1", listenPort: port,
    connectHost: host, connectPort: remote, gatewayPorts: false, addressFamily: "any" };
}
function makeRule(id: string, source: Rule["source"], name: string, enabled: boolean, tunnel: Tunnel | null, automatic: boolean): Rule {
  return { id, source, name, enabled, tunnel, automatic, requestedPort: tunnel?.listenPort ?? null,
    raw: null, actualPort: null, status: "stopped", error: null, sharedWith: [], portConflict: false };
}
function signature(rule: Rule): string { return JSON.stringify([rule.tunnel, rule.enabled, rule.automatic]); }
function snapshot(entry: HostEntry): PortsState {
  return { ssh: { ...entry.ssh }, ports: entry.ports.map((port) => ({ ...port })), forwards: [],
    rules: [...entry.rules.values()].map((rule) => ({ ...rule, sharedWith: [...rule.sharedWith] })),
    scannedAt: entry.scannedAt ? new Date(entry.scannedAt).toISOString() : null,
    scanError: entry.scanError, configError: entry.configError };
}
function message(error: unknown): string { return error instanceof Error ? error.message : String(error); }
