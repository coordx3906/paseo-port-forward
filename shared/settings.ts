import { defineSettings } from "@getpaseo/plugin";
import { z } from "zod";
import { ManualRuleSchema, RuleOverrideSchema } from "./rules";

export const DEFAULT_IGNORE_PORTS = [22, 5432, 6379];

export const PortSettingsSchema = z.object({
  /** Paseo host serverId → SSH destination (`user@host` or a `~/.ssh/config` alias). */
  targets: z.record(z.string(), z.string()).default({}),
  autoForward: z.boolean().default(false),
  ignorePorts: z.array(z.number().int().min(1).max(65535)).default(DEFAULT_IGNORE_PORTS),
  /** Background scan interval while auto-forwarding, in seconds. */
  pollSeconds: z.number().int().min(1).max(60).default(5),
  manualRules: z.array(ManualRuleSchema).default([]),
  ruleOverrides: z.record(z.string(), RuleOverrideSchema).default({}),
});

export type PortSettings = z.output<typeof PortSettingsSchema>;

export const portSettings = defineSettings({
  id: "ports",
  scope: "host",
  version: 1,
  schema: PortSettingsSchema,
});

export function defaultPortSettings(): PortSettings {
  return PortSettingsSchema.parse({});
}

/** "22, 5432 6379" → [22, 5432, 6379]; anything that is not a valid port is dropped. */
export function parsePortList(text: string): number[] {
  const ports = text
    .split(/[\s,]+/)
    .map((part) => Number(part))
    .filter((port) => Number.isInteger(port) && port >= 1 && port <= 65535);
  return [...new Set(ports)].sort((a, b) => a - b);
}
