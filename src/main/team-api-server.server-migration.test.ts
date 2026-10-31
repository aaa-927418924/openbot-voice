import { createHash } from "node:crypto";
import { Effect } from "effect";

// @vitest-environment node

import { isDynamicRecord, isString } from "@openbot/contracts/runtime-values";
import {
  SERVER_MIGRATION_CAPABILITY,
  SERVER_MIGRATION_CHUNK_BYTES_LIMIT,
  SERVER_MIGRATION_CHUNK_SHA256_HEADER,
  SERVER_MIGRATION_JSON_BYTES_LIMIT,
  SERVER_MIGRATION_ROUTES,
} from "@openbot/contracts/team-protocol/server-migration-v1";
import { afterEach, describe, expect, it } from "vitest";
import type { ServerMigrationSnapshotManifest } from "./server-migration-snapshot";
import { createTeamApiFixture, stopTeamApiFixtures, type TeamApiOptions } from "./team-api-server-test-harness";

afterEach(stopTeamApiFixtures);

async function advertisesMigration(response: Response): Promise<boolean> {
  const value = await response.json();
  if (!isDynamicRecord(value) || !Array.isArray(value.capabilities)) {
    throw new Error("Compatibility response is missing its capability list.");
  }
  return value.capabilities.some(
    (capability: unknown) => isString(capability) && capability === SERVER_MIGRATION_CAPABILITY,
  );
}

const manifest: ServerMigrationSnapshotManifest = {
  version: 2,
  createdAt: "2026-10-31T00:00:00.000Z",
  directories: ["user-data", "home", "home/OpenBot"],
  files: [{ path: "user-data/openbot.db", bytes: 1, sha256: "0".repeat(64) }],
  totalBytes: 1,
};

function createMigration() {
  const calls: Array<{ name: string; memberId: string; detail?: unknown }> = [];
  const status = {
    transferId: "transfer-1",
    state: "receiving" as const,
    totalBytes: 1,
    receivedBytes: 0,
    files: [{ path: "user-data/openbot.db", bytes: 1, receivedBytes: 0, complete: false }],
  };
  const verified = { transferId: "transfer-1", manifest };
  const migration: NonNullable<TeamApiOptions["serverMigration"]> = {
    serverMode: true,
    transfer: {
      begin: (input) => {
        calls.push({ name: "begin", memberId: input.memberId, detail: input });
        return Effect.succeed(status);
      },
      status: (memberId, transferId) => {
        calls.push({ name: "status", memberId, detail: transferId });
        return Effect.succeed(status);
      },
      writeChunk: (input) => {
        calls.push({ name: "chunk", memberId: input.memberId, detail: input });
        return Effect.succeed(status);
      },
      cancel: (memberId, transferId) => {
        calls.push({ name: "pause", memberId, detail: transferId });
        return Effect.succeed({ ...status, state: "paused" });
      },
      resume: (memberId, transferId) => {
        calls.push({ name: "resume", memberId, detail: transferId });
        return Effect.succeed(status);
      },
      finalize: (memberId, transferId) => {
        calls.push({ name: "finalize", memberId, detail: transferId });
        return Effect.succeed(verified);
      },
      withVerifiedSnapshot: (memberId, transferId, consume) =>
        Effect.promise(async () => {
          calls.push({ name: "verified-snapshot", memberId, detail: transferId });
          await consume("/private/server/staging/snapshot", manifest);
          return manifest;
        }),
    },
    activate: async (input) => {
      calls.push({ name: "activate", memberId: input.memberId, detail: input });
    },
  };
  return { migration, calls, status, verified };
}

function headers(token: string, contentType?: string): Record<string, string> {
  return {
    Authorization: `Bearer ${token}`,
    "OpenBot-Capabilities": SERVER_MIGRATION_CAPABILITY,
    ...(contentType ? { "Content-Type": contentType } : {}),
  };
}

describe("Team API server migration destination", () => {
  it("advertises only for Linux server mode with the injected transfer and activation boundary", async () => {
    const without = await createTeamApiFixture("server-migration-capability-off");
    const first = await without.start();
    const offResponse = await fetch(`${first.base}/v1/compatibility`);
    expect(await advertisesMigration(offResponse)).toBe(false);

    const disabled = createMigration();
    const secondFixture = await createTeamApiFixture("server-migration-capability-disabled");
    const second = await secondFixture.start({
      serverMigration: { ...disabled.migration, serverMode: false },
    });
    const disabledResponse = await fetch(`${second.base}/v1/compatibility`);
    expect(await advertisesMigration(disabledResponse)).toBe(false);

    const enabled = createMigration();
    const thirdFixture = await createTeamApiFixture("server-migration-capability-on");
    const third = await thirdFixture.start({ serverMigration: enabled.migration });
    const enabledResponse = await fetch(`${third.base}/v1/compatibility`);
    if (process.platform === "linux") expect(await advertisesMigration(enabledResponse)).toBe(true);
    else expect(await advertisesMigration(enabledResponse)).toBe(false);
  });

  it("routes every operation as the authenticated owner and keeps target paths off the wire", async () => {
    const fixture = await createTeamApiFixture("server-migration-routes", { configure: true });
    const stub = createMigration();
    const { base } = await fixture.start({ serverMigration: stub.migration });
    const token = await fixture.signIn();
    const owner = fixture.store.listMembers().find((member) => member.role === "owner");
    expect(owner).toBeDefined();
    const ownerHeaders = headers(token, "application/json");
    const sendJson = (path: string, body: unknown, method = "POST") =>
      fetch(`${base}${path}`, { method, headers: ownerHeaders, body: JSON.stringify(body) });

    const begin = await sendJson(SERVER_MIGRATION_ROUTES.begin, { requestId: "request-1", manifest });
    expect(begin.status).toBe(200);
    expect(await begin.json()).toEqual(stub.status);
    const status = await sendJson(`${SERVER_MIGRATION_ROUTES.status}?transferId=transfer-1`, undefined, "GET");
    expect(status.status).toBe(200);

    const chunk = new Uint8Array([1]);
    const digest = createHash("sha256").update(chunk).digest("hex");
    const chunkResponse = await fetch(
      `${base}${SERVER_MIGRATION_ROUTES.chunk}?transferId=transfer-1&path=user-data%2Fopenbot.db&offset=0`,
      {
        method: "PUT",
        headers: {
          ...headers(token, "application/octet-stream"),
          [SERVER_MIGRATION_CHUNK_SHA256_HEADER]: digest,
        },
        body: chunk,
      },
    );
    expect(chunkResponse.status).toBe(200);
    const pause = await sendJson(SERVER_MIGRATION_ROUTES.pause, { transferId: "transfer-1" });
    expect(pause.status).toBe(200);
    const resume = await sendJson(SERVER_MIGRATION_ROUTES.resume, { transferId: "transfer-1" });
    expect(resume.status).toBe(200);
    const finalize = await sendJson(SERVER_MIGRATION_ROUTES.finalize, { transferId: "transfer-1" });
    expect(finalize.status).toBe(200);
    const finalBody = await finalize.text();
    expect(finalBody).not.toContain("/private/server/staging");
    expect(JSON.parse(finalBody)).toEqual(stub.verified);

    expect(stub.calls.map((call) => call.name)).toEqual([
      "begin",
      "status",
      "chunk",
      "pause",
      "resume",
      "finalize",
      "verified-snapshot",
      "activate",
    ]);
    expect(stub.calls.every((call) => call.memberId === owner?.id)).toBe(true);
    const chunkCall = stub.calls.find((call) => call.name === "chunk");
    expect(chunkCall).toBeDefined();
    if (!isDynamicRecord(chunkCall?.detail)) throw new Error("Chunk transfer was not recorded.");
    expect(chunkCall.detail).toMatchObject({
      memberId: owner?.id,
      transferId: "transfer-1",
      path: "user-data/openbot.db",
      offset: 0,
      sha256: digest,
    });
    if (!(chunkCall.detail.bytes instanceof Uint8Array)) {
      throw new Error("Chunk payload was not forwarded as bytes.");
    }
    expect([...chunkCall.detail.bytes]).toEqual([1]);
    expect(stub.calls.find((call) => call.name === "activate")?.detail).toMatchObject({
      transferId: "transfer-1",
      snapshotPath: "/private/server/staging/snapshot",
    });
  });

  it("rejects non-owners, missing capability, wrong chunk media type, and oversized bodies before transfer", async () => {
    const fixture = await createTeamApiFixture("server-migration-guards", { configure: true });
    const stub = createMigration();
    const { base } = await fixture.start({ serverMigration: stub.migration });
    const ownerToken = await fixture.signIn();
    const invite = await Effect.runPromise(fixture.store.createInvite("member"));
    const member = await Effect.runPromise(fixture.store.acceptInvite(invite.token, "member", "member password"));
    const path = SERVER_MIGRATION_ROUTES.begin;
    const body = JSON.stringify({ requestId: "request-1", manifest });

    const nonOwner = await fetch(`${base}${path}`, {
      method: "POST",
      headers: headers(member.sessionToken, "application/json"),
      body,
    });
    expect(nonOwner.status).toBe(403);

    const noCapability = await fetch(`${base}${path}`, {
      method: "POST",
      headers: { ...headers(ownerToken, "application/json"), "OpenBot-Capabilities": "" },
      body,
    });
    expect(noCapability.status).toBe(404);

    const wrongType = await fetch(
      `${base}${SERVER_MIGRATION_ROUTES.chunk}?transferId=transfer-1&path=user-data%2Fopenbot.db&offset=0`,
      {
        method: "PUT",
        headers: headers(ownerToken, "application/json"),
        body: new Uint8Array([1]),
      },
    );
    expect(wrongType.status).toBe(400);

    const oversizedJson = await fetch(`${base}${path}`, {
      method: "POST",
      headers: headers(ownerToken, "application/json"),
      body: " ".repeat(SERVER_MIGRATION_JSON_BYTES_LIMIT + 1),
    });
    expect(oversizedJson.status).toBe(413);

    const oversizedChunk = new Uint8Array(SERVER_MIGRATION_CHUNK_BYTES_LIMIT + 1);
    const oversizedRaw = await fetch(
      `${base}${SERVER_MIGRATION_ROUTES.chunk}?transferId=transfer-1&path=user-data%2Fopenbot.db&offset=0`,
      {
        method: "PUT",
        headers: {
          ...headers(ownerToken, "application/octet-stream"),
          [SERVER_MIGRATION_CHUNK_SHA256_HEADER]: "0".repeat(64),
        },
        body: oversizedChunk,
      },
    );
    expect(oversizedRaw.status).toBe(413);
    expect(stub.calls).toEqual([]);
  });
});
