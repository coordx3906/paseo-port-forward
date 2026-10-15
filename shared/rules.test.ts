import { describe, expect, it } from "vitest";
import { localForwardUrl, type Rule, type Tunnel } from "./rules";

const tunnel: Tunnel = {
  direction: "local", bindAddress: "localhost", listenPort: 3000,
  connectHost: "127.0.0.1", connectPort: 3000, gatewayPorts: false, addressFamily: "any",
};
const rule: Rule = {
  id: "ssh", source: "ssh", name: "SSH config", enabled: true, automatic: false,
  tunnel, raw: null, requestedPort: 3000, actualPort: 3001, status: "active",
  error: null, sharedWith: [], portConflict: false,
};

describe("local forward URLs", () => {
  it.each([
    ["localhost", "inet6", "[::1]"],
    ["*", "inet6", "[::1]"],
    ["", "inet6", "[::1]"],
    ["::", "any", "[::1]"],
    ["::1", "any", "[::1]"],
    ["localhost", "inet", "127.0.0.1"],
    ["*", "any", "127.0.0.1"],
    ["0.0.0.0", "inet", "127.0.0.1"],
    ["127.0.0.1", "any", "127.0.0.1"],
  ] as const)("opens %s with %s through %s", (bindAddress, addressFamily, host) => {
    expect(localForwardUrl({ ...rule, tunnel: { ...tunnel, bindAddress, addressFamily } }))
      .toBe(`http://${host}:3001`);
  });

  it("does not expose inactive, reverse or non-loopback mappings as local URLs", () => {
    expect(localForwardUrl({ ...rule, status: "error" })).toBeNull();
    expect(localForwardUrl({ ...rule, tunnel: { ...tunnel, direction: "remote" } })).toBeNull();
    expect(localForwardUrl({ ...rule, tunnel: { ...tunnel, bindAddress: "192.168.1.10" } })).toBeNull();
  });
});
