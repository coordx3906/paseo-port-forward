import { defineRpc } from "@getpaseo/plugin";
import { z } from "zod";
import { RuleSchema, PortSchema } from "./rules";

export const SshStatusSchema = z.object({
  state: z.enum(["unmapped", "idle", "connecting", "connected", "error"]),
  target: z.string().nullable(),
  error: z.string().nullable(),
  /** serverId read from the remote's paseo.pid, once connected. */
  remoteServerId: z.string().nullable(),
});
export type SshStatus = z.infer<typeof SshStatusSchema>;

export const RemotePortSchema = z.object({
  port: z.number().int(),
  /** Address the remote socket is bound to, as printed by the remote (e.g. `0.0.0.0`, `::1`). */
  bind: z.string(),
  /** Host the forward connects to on the remote side. */
  connectHost: z.string(),
  pid: z.number().int(),
  process: z.string(),
  command: z.string(),
  agentId: z.string().nullable(),
  cwd: z.string().nullable(),
});
export type RemotePort = z.infer<typeof RemotePortSchema>;

export const ForwardSchema = z.object({
  serverId: z.string(),
  remotePort: z.number().int(),
  connectHost: z.string(),
  localPort: z.number().int(),
  status: z.enum(["active", "error"]),
  error: z.string().nullable(),
  auto: z.boolean(),
});
export type Forward = z.infer<typeof ForwardSchema>;

export const PortsStateSchema = z.object({
  ssh: SshStatusSchema,
  ports: z.array(RemotePortSchema),
  forwards: z.array(ForwardSchema),
  scannedAt: z.string().nullable(),
  scanError: z.string().nullable(),
  rules: z.array(RuleSchema),
  configError: z.string().nullable(),
});
export type PortsState = z.infer<typeof PortsStateSchema>;

const ServerInput = z.object({ serverId: z.string().min(1) });

export const pingRpc = defineRpc({
  name: "ports.ping",
  input: z.object({}),
  output: z.object({ pong: z.literal(true), pid: z.number().int(), platform: z.string() }),
});

export const stateRpc = defineRpc({
  name: "ports.state",
  input: ServerInput,
  output: PortsStateSchema,
});

export const forwardRpc = defineRpc({
  name: "ports.forward",
  input: ServerInput.extend({ remotePort: z.number().int().min(1).max(65535) }),
  output: ForwardSchema,
});

export const unforwardRpc = defineRpc({
  name: "ports.unforward",
  input: ServerInput.extend({ remotePort: z.number().int().min(1).max(65535) }),
  output: z.object({ ok: z.boolean() }),
});

export const testConnectionRpc = defineRpc({
  name: "ports.test-connection",
  input: ServerInput.extend({ target: z.string().min(1).optional() }),
  output: z.object({
    ok: z.boolean(),
    remoteServerId: z.string().nullable(),
    error: z.string().nullable(),
  }),
});

export const refreshConfigRpc = defineRpc({
  name: "ports.refresh-config", input: ServerInput, output: PortsStateSchema,
});
export const retryRuleRpc = defineRpc({
  name: "ports.retry-rule",
  input: ServerInput.extend({ ruleId: z.string().min(1) }), output: PortsStateSchema,
});
export const availablePortRpc = defineRpc({
  name: "ports.available-port",
  input: ServerInput.extend({ ruleId: z.string().min(1) }), output: z.object({ port: PortSchema }),
});
