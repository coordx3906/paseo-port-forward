import { spawn } from "node:child_process";
import { once } from "node:events";
import { describe, expect, it } from "vitest";
import { isLocalPortFree, pickLocalPort } from "./local-port";
import { WindowsHostSession } from "./windows-ssh";

const target = process.env.PASEO_SSH_TEST_TARGET;

describe.skipIf(!target || process.platform !== "win32")("Windows OpenSSH integration", () => {
  it("forwards HTTP and releases the listener when cancelled", async () => {
    // No remote files or settings are changed. The fixture exits on SSH stdin EOF.
    const python = `
import http.server, threading, sys
class Handler(http.server.BaseHTTPRequestHandler):
    def do_GET(self):
        self.send_response(200)
        self.end_headers()
        self.wfile.write(b'paseo-windows-ssh-ok')
    def log_message(self, *args): pass
server = http.server.HTTPServer(('127.0.0.1', 0), Handler)
threading.Thread(target=server.serve_forever, daemon=True).start()
print(server.server_port, flush=True)
sys.stdin.read()
server.shutdown()
`;
    const command = "python3 -u -c '" + python.replaceAll("'", "'\\''") + "'";
    const fixture = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes",
      "-o", "ConnectTimeout=10", target!, command], { windowsHide: true });
    const exited = once(fixture, "close");
    const session = new WindowsHostSession("integration", target!);
    try {
      const remotePort = await new Promise<number>((resolve, reject) => {
        let output = "";
        let stderr = "";
        fixture.stderr.setEncoding("utf8").on("data", (chunk) => { stderr += chunk; });
        fixture.stdout.setEncoding("utf8").on("data", (chunk) => {
          output += chunk;
          if (output.includes("\n")) resolve(Number(output.trim()));
        });
        fixture.once("error", reject);
        fixture.once("close", () => reject(new Error(stderr || "Remote fixture exited")));
      });
      await session.start();
      const localPort = await pickLocalPort(49152, new Set());
      await session.forward(localPort, "127.0.0.1", remotePort);
      expect(await (await fetch(`http://127.0.0.1:${localPort}`)).text()).toBe("paseo-windows-ssh-ok");
      await session.cancel(localPort, "127.0.0.1", remotePort);
      expect(await isLocalPortFree(localPort)).toBe(true);

    } finally {
      await session.stop();
      fixture.stdin.end();
      await exited;
    }
  }, 60_000);
});
