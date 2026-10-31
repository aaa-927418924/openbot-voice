import { describe, expect, it } from "vitest";
import { TEAM_CURRENT_CAPABILITIES } from "./current";
import { optionalRouteCodec } from "./optional-routes";
import { SERVER_MIGRATION_CAPABILITY, SERVER_MIGRATION_ROUTES } from "./server-migration-v1";

const manifest = {
  version: 2,
  createdAt: "2026-10-31T00:00:00.000Z",
  directories: ["user-data", "home", "home/OpenBot"],
  files: [
    {
      path: "user-data/openbot.db",
      bytes: 0,
      sha256: "0".repeat(64),
    },
  ],
  totalBytes: 0,
};

describe("server-migration-v1 contract", () => {
  it("registers an additive capability and bounded begin/finalize codecs", () => {
    expect(TEAM_CURRENT_CAPABILITIES).toContain(SERVER_MIGRATION_CAPABILITY);
    const begin = optionalRouteCodec(SERVER_MIGRATION_ROUTES.begin);
    const finalize = optionalRouteCodec(SERVER_MIGRATION_ROUTES.finalize);
    expect(begin?.request({ requestId: "request-1", manifest })).toEqual({ requestId: "request-1", manifest });
    expect(
      finalize?.response(200, { transferId: "transfer-1", manifest, snapshotPath: "/private/server/path" }),
    ).toEqual({ transferId: "transfer-1", manifest });
  });

  it("rejects malformed manifests and absolute paths in wire data", () => {
    const begin = optionalRouteCodec(SERVER_MIGRATION_ROUTES.begin);
    const status = optionalRouteCodec(SERVER_MIGRATION_ROUTES.status);
    expect(() => begin?.request({ requestId: "", manifest })).toThrow();
    expect(() => begin?.request({ requestId: "request-1", manifest: { ...manifest, version: 1 } })).toThrow();
    expect(() =>
      begin?.request({
        requestId: "request-1",
        manifest: {
          ...manifest,
          files: [{ ...manifest.files[0], path: "../openbot.db" }],
        },
      }),
    ).toThrow();
    expect(() =>
      status?.response(200, {
        transferId: "transfer-1",
        state: "receiving",
        totalBytes: 1,
        receivedBytes: 0,
        files: [{ path: "/private/server/path", bytes: 1, receivedBytes: 0, complete: false }],
      }),
    ).toThrow();
  });
});
