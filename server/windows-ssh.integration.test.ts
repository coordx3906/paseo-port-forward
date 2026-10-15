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
    const remoteNode = (script: string) => session.exec(`node <<'JS'\n${script}\nJS`);
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
      const local: Tunnel = { direction: "local", bindAddress: "127.0.0.1", listenPort: localPort,
        connectHost: "127.0.0.1", connectPort: remotePort, gatewayPorts: false, addressFamily: "any" };
      await session.forwardRule(local);
      expect(await (await fetch(`http://127.0.0.1:${localPort}`)).text()).toBe("paseo-windows-ssh-ok");
      await session.cancelRule(local);
      expect(await isLocalPortFree(localPort)).toBe(true);

      await new Promise<void>((resolve) => localHttp.listen(0, "127.0.0.1", resolve));
      const localHttpPort = (localHttp.address() as { port: number }).port;
      const reversePort = Number((await remoteNode(`
const server = require("node:net").createServer();
server.listen(0, "127.0.0.1", () => {
  const port = server.address().port;
  server.close(() => console.log(port));
});
`)).trim());
      const reverse: Tunnel = { direction: "remote", bindAddress: "127.0.0.1", listenPort: reversePort,
        connectHost: "127.0.0.1", connectPort: localHttpPort, gatewayPorts: false, addressFamily: "any" };
      await session.forwardRule(reverse);
      const response = await remoteNode(`
const request = require("node:http").get("http://127.0.0.1:${reversePort}", response => {
  response.pipe(process.stdout);
});
request.setTimeout(5000, () => request.destroy(new Error("HTTP request timed out")));
`);
      expect(response.trim()).toBe("paseo-reverse-ok");
      await session.cancelRule(reverse);
      const released = await remoteNode(`
const connection = require("node:net").connect(${reversePort}, "127.0.0.1");
connection.once("connect", () => {
  console.log("still listening");
  connection.end();
});
connection.once("error", error => {
  if (error.code !== "ECONNREFUSED") throw error;
  console.log("released");
});
connection.setTimeout(5000, () => connection.destroy(new Error("Port probe timed out")));
`);
      expect(released.trim()).toBe("released");
    } finally {
      await session.stop();
      if (localHttp.listening) await new Promise<void>((resolve, reject) => localHttp.close((error) => error ? reject(error) : resolve()));
      fixture.stdin.end();
      await exited;
    }
  }, 60_000);
});
