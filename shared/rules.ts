import { z } from "zod";

export const PortSchema = z.number().int().min(1).max(65535);
export const TunnelSchema = z.object({
  direction: z.enum(["local", "remote"]),
  bindAddress: z.string().nullable(),
  listenPort: PortSchema,
  connectHost: z.string().min(1),
  connectPort: PortSchema,
  gatewayPorts: z.boolean(),
  addressFamily: z.enum(["any", "inet", "inet6"]),
});
export type Tunnel = z.infer<typeof TunnelSchema>;

export const ManualRuleSchema = z.object({
  id: z.string().min(1), serverId: z.string().min(1),
  remotePort: PortSchema, localPort: PortSchema.nullable(),
  name: z.string(), enabled: z.boolean(),
});
export type ManualRule = z.infer<typeof ManualRuleSchema>;
export const RuleOverrideSchema = z.object({
  enabled: z.boolean().optional(), listenPort: PortSchema.optional(),
});

export const RuleSchema = z.object({
  id: z.string(), source: z.enum(["detected", "manual", "ssh"]),
  name: z.string(), enabled: z.boolean(), automatic: z.boolean(),
  tunnel: TunnelSchema.nullable(), raw: z.string().nullable(),
  requestedPort: PortSchema.nullable(), actualPort: PortSchema.nullable(),
  status: z.enum(["stopped", "connecting", "active", "error"]),
  error: z.string().nullable(), sharedWith: z.array(z.string()),
  portConflict: z.boolean(),
});
export type Rule = z.infer<typeof RuleSchema>;

/** Explicit bind addresses preserve semantics even on a mux master. */
export function effectiveBind(tunnel: Tunnel): string {
  return tunnel.bindAddress ?? (tunnel.direction === "local" && tunnel.gatewayPorts ? "*" : "localhost");
}

export function tunnelKey(tunnel: Tunnel): string {
  return JSON.stringify([tunnel.direction, effectiveBind(tunnel), tunnel.listenPort,
    tunnel.connectHost, tunnel.connectPort, tunnel.addressFamily]);
}

export function tunnelSpec(tunnel: Tunnel): string {
  const address = (host: string) => host.includes(":") && !host.startsWith("[") ? `[${host}]` : host;
  return `${address(effectiveBind(tunnel))}:${tunnel.listenPort}:${address(tunnel.connectHost)}:${tunnel.connectPort}`;
}

export function localForwardUrl(rule: Rule): string | null {
  const tunnel = rule.tunnel;
  if (!tunnel || tunnel.direction !== "local" || rule.status !== "active") return null;
  const bind = effectiveBind(tunnel);
  if (!["127.0.0.1", "::1", "localhost", "*", "", "0.0.0.0", "::"].includes(bind)) return null;
  const ipv6 = bind === "::1" || bind === "::"
    || (["localhost", "*", ""].includes(bind) && tunnel.addressFamily === "inet6");
  return `http://${ipv6 ? "[::1]" : "127.0.0.1"}:${rule.actualPort ?? tunnel.listenPort}`;
}
