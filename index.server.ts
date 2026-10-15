import type { PluginServerContext } from "@getpaseo/plugin/server";

import {
  forwardRpc,
  pingRpc,
  stateRpc,
  testConnectionRpc,
  unforwardRpc,
  refreshConfigRpc,
  retryRuleRpc,
  availablePortRpc,
} from "./shared/contracts";
import { portSettings } from "./shared/settings";
import { PortManager } from "./server/manager";
import { sweepStaleSockets } from "./server/ssh";

export default function contribute(server: PluginServerContext) {
  const manager = new PortManager();
  const settings = server.registerSettings(portSettings);

  const load = async () => {
    const state = await settings.read();
    if (state.status === "ready") manager.applySettings(state.values);
    else console.warn(`[port-forward] settings are invalid: ${state.error}`);
  };
  const ready = sweepStaleSockets()
    .catch((error: unknown) => console.warn("[port-forward] stale socket sweep failed", error))
    .then(load);
  const unsubscribe = settings.subscribe((state) => {
    if (state.status === "ready") manager.applySettings(state.values);
  });

  server.handle(pingRpc, () => ({ pong: true as const, pid: process.pid, platform: process.platform }));
  server.handle(stateRpc, async ({ serverId }) => {
    await ready;
    return manager.state(serverId);
  });
  server.handle(forwardRpc, async ({ serverId, remotePort }) => {
    await ready;
    return manager.forward(serverId, remotePort);
  });
  server.handle(unforwardRpc, async ({ serverId, remotePort }) => {
    await ready;
    return { ok: await manager.unforward(serverId, remotePort) };
  });
  server.handle(testConnectionRpc, async ({ serverId, target }) => {
    await ready;
    return manager.testConnection(serverId, target);
  });
  server.handle(refreshConfigRpc, async ({ serverId }) => {
    await ready;
    return manager.refreshConfig(serverId);
  });
  server.handle(retryRuleRpc, async ({ serverId, ruleId }) => {
    await ready;
    return manager.retryRule(serverId, ruleId);
  });
  server.handle(availablePortRpc, async ({ serverId, ruleId }) => {
    await ready;
    return { port: await manager.availablePort(serverId, ruleId) };
  });

  // The plugin process can die without running cleanup; never leave ssh masters behind.
  const onExit = () => manager.killAll();
  process.once("exit", onExit);

  return async () => {
    process.off("exit", onExit);
    unsubscribe();
    await manager.dispose();
  };
}
