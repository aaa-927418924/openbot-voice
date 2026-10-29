// @vitest-environment node
import { createServer } from "node:net";
import { afterEach, describe, expect, it } from "vitest";
import { assertTcpPortAvailable } from "./identity-api-port-guard";

const servers: ReturnType<typeof createServer>[] = [];

afterEach(async () => {
  await Promise.all(
    servers.splice(0).map(
      (server) =>
        new Promise<void>((resolve, reject) => {
          server.close((error) => (error ? reject(error) : resolve()));
        }),
    ),
  );
});

describe("self-hosted identity API port guard", () => {
  it("refuses to start when another process already listens", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener did not bind to TCP.");

    await expect(assertTcpPortAvailable("127.0.0.1", address.port)).rejects.toThrow("already in use");
  });

  it("allows a port with no listener", async () => {
    const server = createServer();
    servers.push(server);
    await new Promise<void>((resolve, reject) => {
      server.once("error", reject);
      server.listen(0, "127.0.0.1", resolve);
    });
    const address = server.address();
    if (!address || typeof address === "string") throw new Error("Test listener did not bind to TCP.");
    await new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
    servers.splice(servers.indexOf(server), 1);

    await expect(assertTcpPortAvailable("127.0.0.1", address.port)).resolves.toBeUndefined();
  });
});
