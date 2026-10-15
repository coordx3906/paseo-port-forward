import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import { readFileSync } from "node:fs";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { spawn, runSsh } = vi.hoisted(() => ({ spawn: vi.fn(), runSsh: vi.fn() }));
vi.mock("node:child_process", () => ({ spawn }));
vi.mock("./ssh-command", async (original) => ({
  ...await original<typeof import("./ssh-command")>(), runSsh,
}));

import { WindowsHostSession } from "./windows-ssh";
import type { Tunnel } from "../shared/rules";

const mapping: Tunnel = { direction: "local", bindAddress: "127.0.0.1", listenPort: 3000,
  connectHost: "127.0.0.1", connectPort: 3000, gatewayPorts: false, addressFamily: "any" };

async function spawnReady() { await vi.waitFor(() => expect(spawn).toHaveBeenCalled()); }

function child() {
  const process = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
  });
  process.stdin.on("finish", () => queueMicrotask(() => process.emit("close", 0)));
  return process;
}

describe("Windows SSH sessions", () => {
  beforeEach(() => {
    spawn.mockReset();
    runSsh.mockReset().mockResolvedValue({ code: 0, stderr: "", stdout:
      "host my-alias\nhostname example.com\nidentityfile ~/.ssh/key\nlocalforward 3000 localhost:3000\nremoteforward 9000 localhost:9000\n",
    });
  });

  it("waits for remote readiness, forwards without mux, and cancels only the selected port", async () => {
    const host = child();
    const tunnel = child();
    spawn.mockReturnValueOnce(host).mockReturnValueOnce(tunnel);
    const session = new WindowsHostSession("host", "my-alias");
    const starting = session.start();
    await spawnReady();
    host.stdout.write("paseo-port-");
    host.stdout.write("forward-ready\r\n");
    await starting;
    expect(session.running).toBe(true);
    const forwarding = session.forwardRule({ ...mapping, listenPort: 3001 });
    const args = JSON.parse(spawn.mock.calls[1]![1][2]);
    expect(args).toContain("127.0.0.1:3001:127.0.0.1:3000");
    expect(args).toContain("ControlMaster=no");
    const config = readFileSync(args[1], "utf8");
    expect(config).toContain("hostname example.com");
    expect(config).not.toMatch(/(?:local|remote)forward/);
    expect(args).not.toContain("-O");
    expect(spawn.mock.calls[1]![2]).toMatchObject({ windowsHide: true });
    tunnel.stdout.write("paseo-port-forward-ready\n");
    await forwarding;
    await session.cancelRule({ ...mapping, listenPort: 3001 });
    expect(tunnel.stdin.writableEnded).toBe(true);
    expect(host.stdin.writableEnded).toBe(false);
    await session.stop();
    expect(session.running).toBe(false);
    expect(host.stdin.writableEnded).toBe(true);
  });

  it("reports authentication or bind failures before accepting a connection", async () => {
    const host = child();
    spawn.mockReturnValue(host);
    const session = new WindowsHostSession("host", "my-alias");
    const starting = session.start();
    await spawnReady();
    host.stderr.write("Permission denied (publickey).\n");
    host.emit("close", 255);
    await expect(starting).rejects.toThrow("Permission denied (publickey).");
    expect(session.running).toBe(false);
  });

  it("isolates a failed forward from the host and notifies only its rule", async () => {
    const host = child();
    const tunnel = child();
    spawn.mockReturnValueOnce(host).mockReturnValueOnce(tunnel);
    const session = new WindowsHostSession("host", "my-alias");
    const starting = session.start();
    await spawnReady();
    host.stdout.write("paseo-port-forward-ready\n");
    await starting;
    const exited = vi.fn();
    const forwardExited = vi.fn();
    session.onExit(exited);
    session.onForwardExit(forwardExited);
    const forwarding = session.forwardRule(mapping);
    tunnel.stdout.write("paseo-port-forward-ready\n");
    await forwarding;
    tunnel.emit("close", 255);
    expect(exited).not.toHaveBeenCalled();
    expect(forwardExited).toHaveBeenCalledOnce();
    expect(host.stdin.writableEnded).toBe(false);
    expect(session.running).toBe(true);
    await session.stop();
  });

  it("rejects a failed bind without tearing down the host connection", async () => {
    const host = child();
    const tunnel = child();
    spawn.mockReturnValueOnce(host).mockReturnValueOnce(tunnel);
    const session = new WindowsHostSession("host", "my-alias");
    const starting = session.start();
    await spawnReady();
    host.stdout.write("paseo-port-forward-ready\n");
    await starting;
    const forwarding = session.forwardRule(mapping);
    tunnel.stderr.write("Could not request local forwarding.\n");
    tunnel.emit("close", 255);
    await expect(forwarding).rejects.toThrow("Could not request local forwarding.");
    expect(session.running).toBe(true);
    await session.stop();
  });

  it("cancels a pending forward even if readiness arrives before process exit", async () => {
    const host = child();
    const tunnel = child();
    spawn.mockReturnValueOnce(host).mockReturnValueOnce(tunnel);
    const session = new WindowsHostSession("host", "my-alias");
    const starting = session.start();
    await spawnReady();
    host.stdout.write("paseo-port-forward-ready\n");
    await starting;
    const forwarding = session.forwardRule(mapping);
    const rejected = expect(forwarding).rejects.toThrow("Forward was cancelled");
    const cancelling = session.cancelRule(mapping);
    tunnel.stdout.write("paseo-port-forward-ready\n");
    await cancelling;
    await rejected;
    expect(tunnel.stdin.writableEnded).toBe(true);
    expect(session.running).toBe(true);
    await session.stop();
  });
});
