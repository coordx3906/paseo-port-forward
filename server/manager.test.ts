import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { tunnelKey, type Tunnel } from "../shared/rules";
import { defaultPortSettings, type PortSettings } from "../shared/settings";
import type { ConfigRule } from "./ssh-config";

interface SessionStub {
  running: boolean;
  target: string;
  forwarded: Tunnel[];
  exited: (error: string) => void;
  forwardExited: (key: string, error: string) => void;
}

const fake = vi.hoisted(() => ({
  sessions: [] as SessionStub[], configRules: [] as ConfigRule[],
  forward: vi.fn<(tunnel: Tunnel) => Promise<void>>(),
  cancel: vi.fn<(tunnel: Tunnel) => Promise<void>>(),
  free: vi.fn<(port: number, host?: string) => Promise<boolean>>(),
}));
vi.mock("./local-port", () => ({ isLocalPortFree: fake.free }));
vi.mock("./ssh-config", () => ({ readSshConfiguration: vi.fn(async () => ({
  text: "", fingerprint: "same", rules: fake.configRules,
})) }));
vi.mock("./ssh", () => ({ HostSession: class implements SessionStub {
  running = false;
  forwarded: Tunnel[] = [];
  constructor(_serverId: string, readonly target: string) { fake.sessions.push(this); }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  killNow() { this.running = false; }
  exited!: (error: string) => void;
  onExit(listener: (error: string) => void) {
    this.exited = listener;
    return () => {};
  }
  forwardExited!: (key: string, error: string) => void;
  onForwardExit(listener: (key: string, error: string) => void) {
    this.forwardExited = listener;
    return () => {};
  }
  async exec(script: string) {
    const pid = '{"pid":1,"serverId":"srv"}';
    return script.includes("@listen") ? `@pidfile\n${pid}\n@end\n` : pid;
  }
  forwardRule(tunnel: Tunnel) { this.forwarded.push(tunnel); return fake.forward(tunnel); }
  cancelRule(tunnel: Tunnel) { return fake.cancel(tunnel); }
} }));
import { PortManager } from "./manager";

const tunnel: Tunnel = { direction: "local", bindAddress: "127.0.0.1", listenPort: 3000,
  connectHost: "127.0.0.1", connectPort: 3000, gatewayPorts: false, addressFamily: "any" };
const manual = { id: "manual", serverId: "srv", remotePort: 3000, localPort: 3000, name: "Server", enabled: true };
const sshId = "ssh:srv:alias:config";
let manager: PortManager;
let settings: PortSettings;

beforeEach(() => {
  fake.sessions = []; fake.configRules = [];
  fake.forward.mockReset().mockResolvedValue(undefined);
  fake.cancel.mockReset().mockResolvedValue(undefined);
  fake.free.mockReset().mockResolvedValue(true);
  settings = { ...defaultPortSettings(), targets: { srv: "alias" } };
  manager = new PortManager(vi.fn());
});
afterEach(async () => { await manager.dispose(); vi.useRealTimers(); });

describe("rule ownership and failure isolation", () => {
  it.each(["stop", "delete", "change target"] as const)(
    "does not start the old rule after %s during automatic port selection",
    async (action) => {
      let available!: (free: boolean) => void;
      fake.free.mockImplementationOnce(() => new Promise<boolean>((resolve) => { available = resolve; }));
      settings.manualRules = [{ ...manual, localPort: null }];
      manager.applySettings(settings);
      await vi.waitFor(() => expect(fake.free).toHaveBeenCalledTimes(1));
      const oldSession = fake.sessions[0]!;
      settings = action === "change target"
        ? { ...settings, targets: { srv: "new-alias" } }
        : { ...settings, manualRules: action === "delete" ? [] : [{ ...manual, localPort: null, enabled: false }] };
      manager.applySettings(settings);
      available(true);
      await manager.state("srv");
      if (action === "change target") {
        await vi.waitFor(() => expect(fake.sessions.find((session) => session.target === "new-alias")?.forwarded).toHaveLength(1));
        expect(oldSession.running).toBe(false);
      }
      expect(oldSession.forwarded).toEqual([]);
    },
  );

  it("reconnects a lost host connection and reapplies its forwards", async () => {
    settings.manualRules = [manual];
    manager.applySettings(settings);
    await manager.state("srv");
    const oldSession = fake.sessions[0]!;
    vi.useFakeTimers();
    oldSession.running = false;
    oldSession.exited("Connection reset");
    await vi.advanceTimersByTimeAsync(1000);
    const state = await manager.state("srv");
    expect(fake.sessions).toHaveLength(2);
    expect(fake.sessions[1]!.forwarded).toEqual([tunnel]);
    expect(state.ssh.state).toBe("connected");
    expect(state.rules[0]?.status).toBe("active");
  });

  it("reconnects a shared failed tunnel with backoff without restarting healthy forwards", async () => {
    fake.configRules = [{ id: "config", tunnel, raw: "localforward", error: null }];
    settings.manualRules = [manual, { ...manual, id: "healthy", localPort: 3001 }];
    manager.applySettings(settings);
    await manager.state("srv");
    const session = fake.sessions[0]!;
    vi.useFakeTimers();
    fake.forward.mockRejectedValueOnce(new Error("Connection refused"));
    session.forwardExited(tunnelKey(tunnel), "Connection reset");
    expect((await manager.state("srv")).rules.find((rule) => rule.id === "manual")?.status).toBe("error");
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.forward).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1999);
    expect(fake.forward).toHaveBeenCalledTimes(3);
    await vi.advanceTimersByTimeAsync(1);
    const state = await manager.state("srv");
    expect(fake.forward).toHaveBeenCalledTimes(4);
    expect(fake.forward).toHaveBeenLastCalledWith(tunnel);
    expect(fake.sessions).toHaveLength(1);
    expect(state.rules.every((rule) => rule.status === "active")).toBe(true);
    expect(state.rules.find((rule) => rule.id === "manual")?.sharedWith).toEqual([sshId]);
    expect(fake.cancel).not.toHaveBeenCalled();
  });

  it("cancels a pending reconnect when its last source is removed", async () => {
    settings.manualRules = [manual];
    manager.applySettings(settings);
    await manager.state("srv");
    vi.useFakeTimers();
    fake.sessions[0]!.forwardExited(tunnelKey(tunnel), "Connection reset");
    manager.applySettings({ ...settings, manualRules: [] });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fake.forward).toHaveBeenCalledTimes(1);
    expect((await manager.state("srv")).rules).toEqual([]);
  });

  it("shares runtime only and closes it after the last enabled source leaves", async () => {
    fake.configRules = [{ id: "config", tunnel, raw: "localforward", error: null }];
    settings.manualRules = [manual];
    manager.applySettings(settings);
    let state = await manager.state("srv");
    expect(state.rules.filter((rule) => rule.status === "active")).toHaveLength(2);
    expect(fake.forward).toHaveBeenCalledTimes(1);
    settings = { ...settings, manualRules: [] };
    manager.applySettings(settings);
    state = await manager.retryRule("srv", sshId);
    expect(state.rules.find((rule) => rule.id === sshId)?.status).toBe("active");
    expect(fake.cancel).not.toHaveBeenCalled();
    settings = { ...settings, ruleOverrides: { [sshId]: { enabled: false } } };
    manager.applySettings(settings);
    await manager.retryRule("srv", sshId);
    expect(fake.cancel).toHaveBeenCalledTimes(1);
  });

  it("retains manual ports outside discovery and does not block another rule after a bind failure", async () => {
    fake.forward.mockImplementation(async (spec: Tunnel) => {
      if (spec.listenPort === 3000) throw new Error("bind: Address already in use");
    });
    settings.manualRules = [manual, { ...manual, id: "second", localPort: 3001 }];
    manager.applySettings(settings);
    const state = await manager.state("srv");
    expect(state.ports).toEqual([]);
    expect(state.rules.find((rule) => rule.id === "manual")).toMatchObject({ status: "error", portConflict: true });
    expect(state.rules.find((rule) => rule.id === "second")?.status).toBe("active");
  });

  it("chooses another port only for automatic local-port selection", async () => {
    fake.free.mockImplementation(async (port: number) => port !== 3000);
    settings.manualRules = [{ ...manual, localPort: null }];
    manager.applySettings(settings);
    const state = await manager.state("srv");
    expect(state.rules[0]).toMatchObject({ requestedPort: 3000, actualPort: 3001, status: "active" });
  });

  it("restores enabled manual rules and stopped SSH choices from existing configuration", async () => {
    fake.configRules = [{ id: "config", tunnel, raw: "localforward", error: null }];
    settings.manualRules = [manual];
    settings.ruleOverrides = { [sshId]: { enabled: false } };
    manager.applySettings(settings);
    await manager.state("srv");
    await manager.dispose();
    manager = new PortManager(vi.fn());
    manager.applySettings(settings);
    const state = await manager.state("srv");
    expect(state.rules.find((rule) => rule.id === "manual")?.status).toBe("active");
    expect(state.rules.find((rule) => rule.id === sshId)).toMatchObject({ enabled: false, status: "stopped" });
  });

  it("does not turn authentication errors into repeated port attempts", async () => {
    fake.forward.mockRejectedValue(new Error("Permission denied (publickey)."));
    settings.manualRules = [{ ...manual, localPort: null }];
    manager.applySettings(settings);
    const state = await manager.state("srv");
    expect(fake.forward).toHaveBeenCalledTimes(1);
    expect(state.rules[0]).toMatchObject({ status: "error", portConflict: false });
  });

  it("detaches an in-flight rule immediately and rejects late readiness", async () => {
    let ready!: () => void;
    fake.forward.mockImplementation(() => new Promise<void>((resolve) => { ready = resolve; }));
    settings.manualRules = [manual];
    manager.applySettings(settings);
    await vi.waitFor(() => expect(fake.forward).toHaveBeenCalledTimes(1));
    manager.applySettings({ ...settings, manualRules: [] });
    expect(fake.cancel).toHaveBeenCalledTimes(1);
    ready();
    const state = await manager.state("srv");
    expect(state.rules).toEqual([]);
  });
});
