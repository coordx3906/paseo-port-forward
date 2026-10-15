import { createServer } from "node:net";

/** True when nothing on this machine is listening on 127.0.0.1:`port`. */
export function isLocalPortFree(port: number, host = "127.0.0.1"): Promise<boolean> {
  return new Promise((resolve) => {
    const server = createServer();
    server.unref();
    server.once("error", () => resolve(false));
    server.listen({ host, port, exclusive: true, ipv6Only: host.includes(":") }, () => {
      server.close(() => resolve(true));
    });
  });
}

/**
 * The same port number when free, otherwise the next free one, as VS Code does.
 * `taken` covers ports this plugin already handed out but whose listener may not exist yet.
 */
export async function pickLocalPort(
  preferred: number,
  taken: ReadonlySet<number>,
  isFree: (port: number) => Promise<boolean> = isLocalPortFree,
): Promise<number> {
  // Privileged ports need root locally; start such services at 1024 + port instead.
  const start = preferred < 1024 ? 1024 + preferred : preferred;
  for (let port = start; port <= Math.min(start + 100, 65535); port++) {
    if (taken.has(port)) continue;
    if (await isFree(port)) return port;
  }
  throw new Error(`No free local port in ${start}-${start + 100}`);
}
