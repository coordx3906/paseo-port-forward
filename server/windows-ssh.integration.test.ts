import { spawn } from "node:child_process";
import { once } from "node:events";
import { createServer } from "node:http";
import { describe, expect, it } from "vitest";
import { isLocalPortFree, pickLocalPort } from "./local-port";
import { WindowsHostSession } from "./windows-ssh";
import type { Tunnel } from "../shared/rules";

const target = process.env.PASEO_SSH_TEST_TARGET;

describe.skipIf(!target || process.platform !== "win32")("Windows OpenSSH integration", () => {
  it("forwards HTTP in both directions and releases listeners when cancelled", async () => {
    // No remote files or settings are changed. The fixture exits on SSH stdin EOF.
    const script = `
const server = require("node:http").createServer((_request, response) => {
  response.end("paseo-windows-ssh-ok");
});
server.listen(0, "127.0.0.1", () => console.log(server.address().port));
process.stdin.resume();
process.stdin.on("end", () => server.close());
`;
    const command = `node -e '${script}'`;
    const fixture = spawn("ssh", ["-T", "-o", "BatchMode=yes", "-o", "ClearAllForwardings=yes",
      "-o", "ConnectTimeout=10", target!, command], { windowsHide: true });
    const exited = once(fixture, "close");
    const session = new WindowsHostSession("integration", target!);
    const localHttp = createServer((_request, response) => response.end("paseo-reverse-ok"));
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

      await new Promise<void>((resolve) => localHttp.listen(0, "127.0.0.1", resolve));
      const localHttpPort = (localHttp.address() as { port: number }).port;
      const reversePort = Number((await session.exec("python3 -c 'import socket; s=socket.socket(); s.bind((\"127.0.0.1\",0)); print(s.getsockname()[1]); s.close()'")).trim());
      const reverse: Tunnel = { direction: "remote", bindAddress: "127.0.0.1", listenPort: reversePort,
        connectHost: "127.0.0.1", connectPort: localHttpPort, gatewayPorts: false, addressFamily: "any" };
      await session.forwardRule(reverse);
      const response = await session.exec(`python3 -c 'import urllib.request; print(urllib.request.urlopen("http://127.0.0.1:${reversePort}", timeout=5).read().decode())'`);
      expect(response.trim()).toBe("paseo-reverse-ok");
      await session.cancelRule(reverse);
      const released = await session.exec(`python3 - <<'PY'
import socket
try:
    connection = socket.create_connection(("127.0.0.1", ${reversePort}), timeout=5)
except ConnectionRefusedError:
    print("released")
else:
    connection.close()
    print("still listening")
PY`);
      expect(released.trim()).toBe("released");
    } finally {
      await session.stop();
      if (localHttp.listening) await new Promise<void>((resolve, reject) => localHttp.close((error) => error ? reject(error) : resolve()));
      fixture.stdin.end();
      await exited;
    }
  }, 60_000);
});
