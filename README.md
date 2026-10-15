# paseo-port-forward

A Paseo plugin that adds a **Ports** screen and forwards ports open on a remote Paseo host to your laptop's `localhost`, similar to VS Code Remote's port forwarding.

The plugin runs only on your laptop's Paseo daemon. It reaches remote hosts over your own SSH connection, so it also works for hosts you connect to through the Paseo relay. Nothing is installed on the remote; a read-only scan script runs there over SSH.

![Ports screen](images/ports-screen.png)

## Setup

1. Install the plugin on the **laptop** daemon:
   ```bash
   paseo plugin install /path/to/paseo-port-forward
   ```
2. Open **Ports** from the sidebar (or the command center, "Open Ports").
3. Pick a remote host and enter its SSH target: `user@host` or an alias from `~/.ssh/config`. **Test connection** checks that the machine you reach is the same Paseo host (its `~/.paseo/paseo.pid` `serverId` must match).
4. Press **Forward** on a port. It is served on `http://localhost:<port>`, or the next free port when that one is taken locally.

Settings → Plugins → **Port forwarding** has the SSH targets, auto-forward, the ignore list and the auto-forward poll interval.

## Manual ports and SSH configuration

Use **Add port** for services started outside Paseo. Enter a remote port and optionally
a local port and name. Manual entries are saved and restored when the plugin restarts;
they remain listed even when the service is not found by the Paseo process scan.
Stop keeps the entry disabled, while Delete removes it.

Static TCP `LocalForward` and `RemoteForward` rules for each configured SSH target are
loaded automatically using `ssh -G`. **Refresh SSH config** applies additions and
removals. The plugin preserves bind addresses and direction, and displays unsupported
rules individually. Dynamic SOCKS and Unix socket forwards are not supported.

Each source can be stopped separately. Identical enabled mappings share one tunnel;
removing one source does not stop the remaining sources. SSH settings are read-only:
port overrides and disabled states are stored only in the plugin.

An automatically selected local port moves to the next available port when occupied.
Explicit local ports and imported ports report conflicts instead; **Use available port**
or **Change port** lets you change the mapping. One failed rule does not stop other
forwards. Reverse rules show the requested remote bind, whose actual scope is subject
to the SSH server's policy. An active tunnel does not guarantee application health.

Plugin-created connections and ProxyJump hops do not inherit static forwards.
Explicit ProxyCommand commands are preserved; commands they start manage their own
SSH configuration and forwarding behavior.

Requirements:
- Paseo `>=0.11.1`.
- A macOS, Linux or Windows laptop with OpenSSH (`ssh` on PATH).
- Linux remotes.
- Key- or agent-based SSH. `BatchMode=yes` is used, so password prompts and unknown host keys fail with an error instead of hanging. Connect once by hand to accept a new host key.

## How it works

```
Laptop daemon
└─ plugin backend (Node)
   ├─ one ssh ControlMaster per remote host  (ssh -M -S /tmp/paseo-pf-<uid>/<hash>.sock -N <target>)
   ├─ scan: `sh -s` over the master every ~2 s while the screen is open
   └─ forwards: ssh -S <sock> -O forward|cancel -L 127.0.0.1:<lport>:<host>:<rport>
```

- **Detection** reads `/proc/net/tcp{,6}` for `LISTEN` sockets and maps socket inodes to pids through `/proc/<pid>/fd`. It keeps only processes descending from the Paseo supervisor in `~/.paseo/paseo.pid`. It drops:
  - the supervisor and the daemon worker;
  - the daemon's listen port;
  - Paseo's own helpers (terminal worker, esbuild);
  - anything under a plugin-host process.

  Each port carries the process, command line, `PASEO_AGENT_ID` and `PASEO_AGENT_CWD` from its environment. Terminal processes have no agent id and show their working directory instead.
- **Forwarding** for detected and manually added ports binds locally to `127.0.0.1`. Imported SSH rules retain their requested bind and direction. Detected wildcard and loopback remote binds connect to `127.0.0.1` (IPv4) or `localhost` (`::`); specific addresses are used as-is.
- **Auto-forward** forwards every new detected port on every host with an SSH target, minus the ignore list (default `22, 5432, 6379`). Closing a detected port removes only its detected source; saved manual and SSH rules remain.
- **Reconnect:** if the master dies, it reconnects with backoff (1 s up to 30 s) and reapplies the forwards on the same local ports.
- **Cleanup:**
  - Disabling or reloading the plugin cancels all forwards and closes the masters.
  - Each master runs under a small `sh` watchdog that kills it when the plugin process's pipe closes, so a crashed or SIGKILLed plugin leaves no `ssh`, socket or local listener behind.
  - Stale control sockets are swept on start.
- **Idle:** a master with no forwards closes after 2 minutes without the screen polling it.

### Windows

Windows uses the built-in OpenSSH client without ControlMaster or a local Unix shell.
It keeps one SSH connection for the host and one per forwarded port; scans use separate
SSH commands. Each persistent connection runs under a Node watchdog that terminates
SSH when the plugin's stdin pipe closes, including after a plugin crash. A failed
connection reconnects through the same mechanism as on macOS/Linux.

Enable Windows' **OpenSSH Client** optional feature and make sure `ssh` is on the
daemon's PATH. Keys, the SSH agent and `%USERPROFILE%\.ssh\config` work as usual.
The remote host must still run Linux.

The plugin resolves the target's effective SSH configuration once per session and
removes inherited `LocalForward`, `RemoteForward` and `DynamicForward` entries.
Only the ports selected in Paseo are forwarded; your SSH configuration is not edited.

## Phase 0 findings (Paseo 0.11.1)

The plan in issue #1 assumed a workspace-panel tab. These are the answers to its open questions, read from the app bundle and checked against the running daemon:

1. **RPC routing.** `useRpc` goes to the daemon of the host the plugin is installed on. Each installed plugin's client runtime is created per host (`byHost`, keyed by `serverId`), and its `invoke` calls that host's `invokePluginRpc`. `PaseoApi` (`getPaseoClient`) exposes no plugin RPC, so there is no supported way to call this plugin's backend from a UI that belongs to another host.
2. **Panels on other hosts.** No. Workspace panels are only offered for plugins whose `serverId` equals the workspace's host, so a laptop-only plugin never shows a tab in a remote workspace. That is why the UI is a laptop-host **screen plus sidebar item** that covers every remote host (`useHosts()`), instead of a per-workspace tab.
3. **Local daemon.** The plugin needs a daemon on the laptop to run its backend; the Ports screen only appears when one is connected.
4. **Opening URLs.** `navigation.openBrowser` needs a `workspaceId`, which a global screen doesn't have. **Open** uses `openExternalUrl` instead. The forwarded URL is on the laptop's localhost either way.

Agent titles come from `getPaseoClient(serverId).agents.list()`, best effort. Workspace scoping isn't implemented, because a global screen has no selected workspace.

## Development

```bash
npm install
npm run typecheck
npm test
```

On Windows, set `PASEO_SSH_TEST_TARGET` to a Linux SSH alias before `npm test` to
include the integration test. It uses Node on the remote (available as `node` on the
SSH command's PATH), starts a temporary
HTTP server in memory, and checks HTTP forwarding in both directions, cancellation
and listener release without changing remote files or settings.

`server/fixtures/linux-scan.txt` is real scan output from a Linux container running Paseo 0.11.1, with a terminal-started server, an agent-tagged server, and an unrelated server that must be excluded.

## Limitations

- Linux remotes only. macOS remotes would need `lsof` (planned).
- No workspace tab (see Phase 0 above).
- No password or interactive SSH authentication.
