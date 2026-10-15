Port forwarding adds a Ports screen that lists TCP ports opened by Paseo agents and terminals on your remote Paseo hosts. You can forward each one to `localhost` on your laptop with one click, or automatically, like VS Code Remote's Ports view.

Install it on your laptop's daemon only. It opens its own SSH connection to each remote host using the system `ssh`, your keys and agent, and `~/.ssh/config`, so it works for hosts you reach over SSH, Tailscale or the Paseo relay, as long as you can SSH to them. Nothing is installed on the remote. A read-only script reads `/proc` and `~/.paseo/paseo.pid` there.

Setup: give each remote host an SSH target (`user@host` or a config alias). Before forwarding, the plugin checks that the machine it reaches reports the same Paseo `serverId`. Password prompts are not supported. Accept a new host key once by hand.

Forwards bind to `127.0.0.1` only and use the same port number when it is free locally, otherwise the next free one. Auto-forward mode forwards new ports on every configured host, skips an ignore list (default 22, 5432, 6379), and removes the forward when the remote port closes. Disabling the plugin closes every forward and SSH connection.

Requires Paseo 0.11.1 or later, a macOS, Linux or Windows laptop, and Linux remotes. Windows uses separate SSH connections instead of ControlMaster.
