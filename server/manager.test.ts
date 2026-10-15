import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { Tunnel } from "../shared/rules";
import { defaultPortSettings, type PortSettings } from "../shared/settings";

const fake = vi.hoisted(() => ({
  sessions: [] as any[], configRules: [] as any[],
  forward: vi.fn(), cancel: vi.fn(), free: vi.fn(),
}));
vi.mock("./local-port", () => ({ isLocalPortFree: fake.free }));
vi.mock("./ssh-config", () => ({ readSshConfiguration: vi.fn(async () => ({
  text: "", fingerprint: "same", rules: fake.configRules,
})) }));
vi.mock("./ssh", () => ({ HostSession: class {
  running = false;
  constructor() { fake.sessions.push(this); }
  async start() { this.running = true; }
  async stop() { this.running = false; }
  killNow() { this.running = false; }
  onExit() { return () => {}; }
  onForwardExit() { return () => {}; }
  async exec(script: string) {
    const pid = '{"pid":1,"serverId":"srv"}';
    return script.includes("@listen") ? `@pidfile\n${pid}\n@end\n` : pid;
  }
  forwardRule(tunnel: Tunnel) { return fake.forward(tunnel); }
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
afterEach(async () => { await manager.dispose(); });

describe("rule ownership and failure isolation", () => {
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
