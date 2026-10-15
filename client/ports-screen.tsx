import type { PluginTheme } from "@getpaseo/plugin";
import type { PluginScreenProps } from "@getpaseo/plugin/client";
import { getPaseoClient, openExternalUrl, useHosts, useRpc } from "@getpaseo/plugin/client";
import { SettingsInput } from "@getpaseo/plugin/client/ui";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { useMemo, useState } from "react";
import { ActivityIndicator, Pressable, ScrollView, Text, View } from "react-native";
import { availablePortRpc, forwardRpc, refreshConfigRpc, retryRuleRpc, stateRpc, testConnectionRpc, unforwardRpc, type PortsState } from "../shared/contracts";
import { effectiveBind, PortSchema, type ManualRule, type Rule } from "../shared/rules";
import { makeStyles, type Styles } from "./styles";
import { usePortSettings } from "./use-port-settings";
import { canCopy, copyText } from "./web";

export function PortsScreen({ theme, layout, host, params }: PluginScreenProps) {
  const styles = useMemo(() => makeStyles(theme, layout.compact), [theme, layout.compact]);
  const remotes = useHosts().filter((candidate) => candidate.serverId !== host.id);
  const [picked, setPicked] = useState<string | null>(params.serverId ?? null);
  const selected = remotes.find((remote) => remote.serverId === picked) ?? remotes[0];
  return (
    <ScrollView style={styles.screen} contentContainerStyle={styles.content}>
      <Text style={styles.title}>Ports</Text>
      <Text style={styles.muted}>Forward detected ports, add your own, or use static rules from your SSH config.</Text>
      {!selected ? <View style={styles.card}><Text style={styles.text}>Add a remote Paseo host to manage its ports.</Text></View> : <>
        <View style={styles.chips}>{remotes.map((remote) => (
          <Pressable key={remote.serverId} accessibilityRole="button" onPress={() => setPicked(remote.serverId)}
            style={[styles.chip, remote.serverId === selected.serverId && styles.chipActive]}>
            <Text style={remote.serverId === selected.serverId ? styles.chipTextActive : styles.chipText}>{remote.label}</Text>
          </Pressable>
        ))}</View>
        <HostPorts key={selected.serverId} serverId={selected.serverId} label={selected.label} styles={styles} theme={theme} />
      </>}
    </ScrollView>
  );
}

interface HostProps { serverId: string; label: string; styles: Styles; theme: PluginTheme }
function HostPorts({ serverId, label, styles, theme }: HostProps) {
  const { values, setTarget } = usePortSettings();
  const [editing, setEditing] = useState(false);
  const target = values?.targets[serverId];
  if (!values) return <ActivityIndicator color={theme.colors.foregroundMuted} />;
  if (!target || editing) return <TargetForm serverId={serverId} label={label} initial={target ?? ""} styles={styles}
    onSave={async (next) => { await setTarget(serverId, next); setEditing(false); }}
    onCancel={target ? () => setEditing(false) : undefined} />;
  return <PortList serverId={serverId} styles={styles} theme={theme} onEditTarget={() => setEditing(true)} />;
}

function TargetForm({ serverId, label, initial, styles, onSave, onCancel }: {
  serverId: string; label: string; initial: string; styles: Styles;
  onSave(target: string): Promise<void>; onCancel?: () => void;
}) {
  const [draft, setDraft] = useState(initial);
  const test = useMutation({ mutationFn: useRpc(testConnectionRpc) });
  const save = useMutation({ mutationFn: () => onSave(draft.trim()) });
  return <View style={styles.card}>
    <Text style={styles.text}>Configure SSH target for {label}</Text>
    <Text style={styles.muted}>Use user@host or a ~/.ssh/config alias. Key or agent authentication is required.</Text>
    <SettingsInput label="SSH target" initialValue={initial} onChangeText={setDraft} placeholder="ubuntu@gpu-box"
      error={test.data && !test.data.ok ? test.data.error : null}
      hint={test.data?.ok ? `Verified: ${test.data.remoteServerId}` : undefined} />
    <View style={styles.row}>
      <Button styles={styles} label={test.isPending ? "Testing…" : "Test connection"} disabled={!draft.trim() || test.isPending}
        onPress={() => test.mutate({ serverId, target: draft.trim() })} />
      <Button styles={styles} primary label="Save" disabled={!draft.trim() || save.isPending} onPress={() => save.mutate()} />
      {onCancel ? <Button styles={styles} label="Cancel" onPress={onCancel} /> : null}
    </View>
    {test.error || save.error ? <Text style={styles.danger}>{String(test.error ?? save.error)}</Text> : null}
  </View>;
}

function PortList({ serverId, styles, theme, onEditTarget }: Omit<HostProps, "label"> & { onEditTarget(): void }) {
  const load = useRpc(stateRpc);
  const refresh = useRpc(refreshConfigRpc);
  const retry = useRpc(retryRuleRpc);
  const available = useRpc(availablePortRpc);
  const forward = useRpc(forwardRpc);
  const unforward = useRpc(unforwardRpc);
  const { values, update } = usePortSettings();
  const client = useQueryClient();
  const queryKey = ["ports", serverId];
  const query = useQuery({ queryKey, queryFn: () => load({ serverId }), refetchInterval: 2000 });
  const agentTitles = useQuery({ queryKey: ["agent-titles", serverId], staleTime: 15000, refetchInterval: 15000, retry: false,
    queryFn: async () => Object.fromEntries((await getPaseoClient(serverId).agents.list()).entries.map(({ agent }) => [agent.id, agent.title])),
  });
  const [form, setForm] = useState<ManualRule | "new" | null>(null);
  const [portEditor, setPortEditor] = useState<Rule | null>(null);

  const operation = useMutation({
    mutationFn: async ({ rule, action, port }: { rule?: Rule; action: string; port?: number }) => {
      if (action === "refresh") { await refresh({ serverId }); return; }
      if (!rule) return;
      if (action === "retry") { await retry({ serverId, ruleId: rule.id }); return; }
      if (rule.source === "detected") {
        const remotePort = rule.tunnel!.connectPort;
        if (rule.enabled) await unforward({ serverId, remotePort });
        else await forward({ serverId, remotePort });
        return;
      }
      if (action === "choose") port = (await available({ serverId, ruleId: rule.id })).port;
      await update((current) => {
        if (rule.source === "manual") return { ...current, manualRules: action === "delete"
          ? current.manualRules.filter((item) => item.id !== rule.id)
          : current.manualRules.map((item) => item.id !== rule.id ? item : { ...item,
            ...(action === "toggle" ? { enabled: !item.enabled } : {}),
            ...(port !== undefined ? { localPort: port, enabled: true } : {}),
          }) };
        const next = { ...current.ruleOverrides[rule.id] };
        if (action === "toggle") next.enabled = !rule.enabled;
        if (port !== undefined) { next.listenPort = port; next.enabled = true; }
        if (action === "reset") delete next.listenPort;
        return { ...current, ruleOverrides: { ...current.ruleOverrides, [rule.id]: next } };
      });
    },
    onSettled: () => client.invalidateQueries({ queryKey }),
  });
  const state = query.data;
  if (!state || !values) return <View style={styles.card}>{query.error
    ? <Text style={styles.danger}>{String(query.error)}</Text>
    : <ActivityIndicator color={theme.colors.foregroundMuted} />}</View>;
  return <View style={styles.stack}>
    <SshHeader state={state} styles={styles} theme={theme} onEditTarget={onEditTarget} />
    <View style={styles.row}>
      <Button styles={styles} primary label="Add port" onPress={() => setForm("new")} />
      <Button styles={styles} label="Refresh SSH config" disabled={operation.isPending} onPress={() => operation.mutate({ action: "refresh" })} />
    </View>
    {form ? <ManualForm key={form === "new" ? "new" : form.id} initial={form === "new" ? undefined : form}
      styles={styles} onCancel={() => setForm(null)} onSave={async (draft) => {
        const item: ManualRule = { ...draft, id: form === "new" ? `manual:${serverId}:${Date.now()}:${Math.random().toString(36).slice(2)}` : form.id,
          serverId, enabled: form === "new" ? true : form.enabled };
        await update((current) => ({ ...current, manualRules: [...current.manualRules.filter((rule) => rule.id !== item.id), item] }));
        setForm(null);
        await client.invalidateQueries({ queryKey });
      }} /> : null}
    {portEditor ? <PortEditor key={portEditor.id} rule={portEditor} styles={styles} onCancel={() => setPortEditor(null)}
      onSave={async (port) => { await operation.mutateAsync({ rule: portEditor, action: "port", port }); setPortEditor(null); }} /> : null}
    {operation.error ? <Text style={styles.danger}>{String(operation.error)}</Text> : null}
    {state.configError ? <Text style={styles.danger}>SSH config: {state.configError}</Text> : null}
    {!state.rules.length ? <View style={styles.card}><Text style={styles.muted}>No ports yet. Add a port, configure SSH forwards, or start a server from a Paseo agent or terminal.</Text></View> : null}
    {state.rules.map((rule) => <RuleRow key={rule.id} rule={rule} styles={styles} theme={theme}
      busy={operation.isPending && operation.variables?.rule?.id === rule.id}
      process={rule.source === "detected" ? state.ports.find((port) => port.port === rule.tunnel?.connectPort) : undefined}
      agentTitles={agentTitles.data}
      onAction={(action) => {
        if (action === "edit") {
          const manual = values.manualRules.find((item) => item.id === rule.id);
          if (manual) setForm(manual);
        } else if (action === "port") setPortEditor(rule);
        else operation.mutate({ rule, action });
      }} />)}
  </View>;
}

function SshHeader({ state, styles, theme, onEditTarget }: {
  state: PortsState; styles: Styles; theme: PluginTheme; onEditTarget(): void;
}) {
  const color = state.ssh.state === "connected" ? theme.colors.statusSuccess
    : state.ssh.state === "error" ? theme.colors.statusDanger : theme.colors.statusWarning;
  return <View style={styles.card}>
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.text}>SSH {state.ssh.state} · {state.ssh.target}</Text>
      <View style={styles.spacer} />
      <Button styles={styles} label="Change target" onPress={onEditTarget} />
    </View>
    {state.ssh.error ?? state.scanError ? <Text style={styles.danger}>{state.ssh.error ?? state.scanError}</Text> : null}
  </View>;
}

function RuleRow({ rule, styles, theme, busy, process, agentTitles, onAction }: {
  rule: Rule; styles: Styles; theme: PluginTheme; busy: boolean;
  process?: PortsState["ports"][number]; agentTitles?: Record<string, string | null | undefined>; onAction(action: string): void;
}) {
  const tunnel = rule.tunnel;
  const local = tunnel?.direction === "local";
  const port = rule.actualPort ?? tunnel?.listenPort;
  const bind = tunnel ? effectiveBind(tunnel) : "";
  const accessible = ["127.0.0.1", "::1", "localhost", "*", "", "0.0.0.0", "::"].includes(bind);
  const host = bind === "::1" || bind === "::" ? "[::1]" : "127.0.0.1";
  const url = local && accessible && rule.status === "active" ? `http://${host}:${port}` : null;
  const mapping = tunnel ? `${local ? "Local" : "Remote requested"} ${bind}:${port} → ${local ? "remote" : "local"} ${tunnel.connectHost}:${tunnel.connectPort}` : rule.raw;
  const color = rule.status === "active" ? theme.colors.statusSuccess : rule.status === "error" ? theme.colors.statusDanger : theme.colors.border;
  return <View style={styles.card}>
    <View style={styles.row}>
      <View style={[styles.dot, { backgroundColor: color }]} />
      <Text style={styles.text}>{rule.name}</Text>
      <Text style={styles.muted}>{rule.source === "ssh" ? "SSH config" : rule.source === "manual" ? "Manual" : "Detected"} · {rule.status}</Text>
      <View style={styles.spacer} />
      {url ? <>
        <Button styles={styles} label="Open" onPress={() => void openExternalUrl(url)} />
        {canCopy() ? <Button styles={styles} label="Copy URL" onPress={() => void copyText(url)} /> : null}
      </> : null}
      {!local && tunnel && canCopy() ? <Button styles={styles} label="Copy mapping" onPress={() => void copyText(mapping ?? "")} /> : null}
      <Button styles={styles} primary={!rule.enabled} label={rule.enabled ? "Stop" : "Start"} disabled={busy || !tunnel} onPress={() => onAction("toggle")} />
      {rule.status === "error" && tunnel && rule.enabled ? <Button styles={styles} label="Retry" disabled={busy} onPress={() => onAction("retry")} /> : null}
      {rule.source === "manual" ? <>
        <Button styles={styles} label="Edit" disabled={busy} onPress={() => onAction("edit")} />
        <Button styles={styles} label="Delete" disabled={busy} onPress={() => onAction("delete")} />
      </> : null}
      {rule.source === "ssh" && tunnel ? <>
        <Button styles={styles} label="Change port" disabled={busy} onPress={() => onAction("port")} />
        {rule.requestedPort !== tunnel.listenPort ? <Button styles={styles} label="Use config port" disabled={busy} onPress={() => onAction("reset")} /> : null}
      </> : null}
      {local && rule.source !== "detected" && rule.portConflict ? <Button styles={styles} label="Use available port" disabled={busy} onPress={() => onAction("choose")} /> : null}
    </View>
    <Text style={styles.text}>{mapping}</Text>
    {rule.actualPort && rule.requestedPort !== rule.actualPort ? <Text style={styles.muted}>Requested port {rule.requestedPort}; using {rule.actualPort}.</Text> : null}
    {rule.sharedWith.length ? <Text style={styles.muted}>{rule.enabled ? "Shared with another source." : "This source is stopped; another source still uses this mapping."}</Text> : null}
    {process ? <Text style={styles.muted} numberOfLines={1}>{process.process} (pid {process.pid}){process.agentId ? ` · agent ${agentTitles?.[process.agentId] ?? process.agentId.slice(0, 8)}` : " · terminal"}{process.cwd ? ` · ${process.cwd}` : ""}</Text> : null}
    {rule.error ? <Text style={styles.danger}>{rule.error}</Text> : null}
  </View>;
}

function parsePort(text: string): number {
  if (!/^\d+$/.test(text.trim())) throw new Error("Enter a port from 1 to 65535");
  const result = PortSchema.safeParse(Number(text));
  if (!result.success) throw new Error("Enter a port from 1 to 65535");
  return result.data;
}

function ManualForm({ initial, styles, onSave, onCancel }: {
  initial?: ManualRule; styles: Styles;
  onSave(draft: Pick<ManualRule, "remotePort" | "localPort" | "name">): Promise<void>; onCancel(): void;
}) {
  const [remote, setRemote] = useState(initial ? String(initial.remotePort) : "");
  const [local, setLocal] = useState(initial?.localPort ? String(initial.localPort) : "");
  const [name, setName] = useState(initial?.name ?? "");
  const save = useMutation({ mutationFn: () => onSave({ remotePort: parsePort(remote), localPort: local.trim() ? parsePort(local) : null, name: name.trim() }) });
  return <View style={styles.card}>
    <Text style={styles.text}>{initial ? "Edit port" : "Add port"}</Text>
    <SettingsInput label="Remote port" initialValue={remote} onChangeText={setRemote} placeholder="3000" />
    <SettingsInput label="Local port (optional)" initialValue={local} onChangeText={setLocal} hint="Leave blank to choose an available port automatically." />
    <SettingsInput label="Name (optional)" initialValue={name} onChangeText={setName} placeholder="Development server" />
    <View style={styles.row}>
      <Button styles={styles} primary label={save.isPending ? "Saving…" : "Save"} disabled={save.isPending} onPress={() => save.mutate()} />
      <Button styles={styles} label="Cancel" onPress={onCancel} />
    </View>
    {save.error ? <Text style={styles.danger}>{String(save.error)}</Text> : null}
  </View>;
}

function PortEditor({ rule, styles, onSave, onCancel }: {
  rule: Rule; styles: Styles; onSave(port: number): Promise<void>; onCancel(): void;
}) {
  const [port, setPort] = useState(String(rule.tunnel!.listenPort));
  const save = useMutation({ mutationFn: () => onSave(parsePort(port)) });
  return <View style={styles.card}>
    <SettingsInput label={rule.tunnel!.direction === "remote" ? "Requested remote listening port" : "Local listening port"}
      initialValue={port} onChangeText={setPort} hint="Saved in this plugin only. Your SSH config is unchanged." />
    <View style={styles.row}>
      <Button styles={styles} primary label="Save" disabled={save.isPending} onPress={() => save.mutate()} />
      <Button styles={styles} label="Cancel" onPress={onCancel} />
    </View>
    {save.error ? <Text style={styles.danger}>{String(save.error)}</Text> : null}
  </View>;
}

function Button({ label, onPress, disabled, primary, styles }: {
  label: string; onPress(): void; disabled?: boolean; primary?: boolean; styles: Styles;
}) {
  return <Pressable accessibilityRole="button" accessibilityLabel={label} disabled={disabled} onPress={onPress}
    style={[styles.button, primary && styles.buttonPrimary, disabled && styles.buttonDisabled]}>
    <Text style={primary ? styles.buttonPrimaryText : styles.buttonText}>{label}</Text>
  </Pressable>;
}
