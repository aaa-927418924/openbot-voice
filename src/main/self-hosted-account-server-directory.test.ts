// @vitest-environment node

import { generateKeyPairSync, randomBytes, sign } from "node:crypto";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  type AccountServerRegistration,
  accountServerVisibilityPayload,
} from "@openbot/contracts/account-server-directory";
import { remoteHostFingerprint } from "@openbot/team-client/remote-directory";
import { afterEach, describe, expect, it } from "vitest";
import { AccountServerDirectoryError, SelfHostedAccountServerDirectory } from "./self-hosted-account-server-directory";

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe("SelfHostedAccountServerDirectory owner visibility", () => {
  it("recovers a missing server registration only with a proof bound to its metadata", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-account-directory-visibility-"));
    roots.push(root);
    const directory = new SelfHostedAccountServerDirectory(join(root, "directory.json"));
    await directory.initialize();
    const accountId = "account-owner";
    const hostId = "linux-host";
    const { publicKey, privateKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const registration: AccountServerRegistration = {
      hostId,
      name: "Linux OpenBot",
      apiUrl: "http://100.100.10.2:43123",
      fingerprint: remoteHostFingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "linux-owner-member",
      role: "owner",
    };
    const proof = (visible: boolean, signedRegistration?: AccountServerRegistration) => {
      const unsigned = { hostId, visible, nonce: randomBytes(24).toString("base64url") };
      return {
        ...unsigned,
        signature: sign(
          null,
          Buffer.from(accountServerVisibilityPayload(accountId, unsigned, signedRegistration)),
          privateKey,
        ).toString("base64url"),
      };
    };

    await expect(directory.setServerVisibleWithOwnerProof(accountId, proof(true))).rejects.toMatchObject({
      status: 404,
    });
    const tampered = { ...registration, apiUrl: "http://100.100.99.99:43123" };
    await expect(
      directory.setServerVisibleWithOwnerProof(accountId, proof(true, registration), tampered),
    ).rejects.toBeInstanceOf(AccountServerDirectoryError);
    const cloudRegistration = { ...registration, origin: "cloud" as const };
    await expect(
      directory.setServerVisibleWithOwnerProof(accountId, proof(true, registration), cloudRegistration),
    ).rejects.toBeInstanceOf(AccountServerDirectoryError);
    expect(await directory.list(accountId)).toEqual([]);

    await directory.setServerVisibleWithOwnerProof(accountId, proof(true, cloudRegistration), cloudRegistration);
    expect(await directory.list(accountId)).toMatchObject([
      { hostId, name: registration.name, apiUrl: registration.apiUrl, role: "member", origin: "cloud" },
    ]);

    await directory.removeMembership(accountId, hostId);
    await expect(
      directory.setServerVisibleWithOwnerProof(accountId, proof(false, cloudRegistration), cloudRegistration),
    ).rejects.toMatchObject({ status: 404 });
    expect(await directory.list(accountId)).toEqual([]);

    await directory.setServerVisibleWithOwnerProof(accountId, proof(true, cloudRegistration), cloudRegistration);
    expect(await directory.list(accountId)).toHaveLength(1);
  });

  it("lists a host once per account and applies visibility globally", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-account-directory-overview-"));
    roots.push(root);
    const directory = new SelfHostedAccountServerDirectory(join(root, "directory.json"));
    await directory.initialize();
    const { publicKey } = generateKeyPairSync("ed25519", {
      publicKeyEncoding: { type: "spki", format: "pem" },
      privateKeyEncoding: { type: "pkcs8", format: "pem" },
    });
    const server: AccountServerRegistration = {
      hostId: "shared-linux-host",
      name: "OpenBot",
      apiUrl: "http://100.100.10.2:43123",
      fingerprint: remoteHostFingerprint(publicKey),
      publicKey,
      logoKey: null,
      membershipId: "member-one",
      role: "member",
    };
    await directory.register("account-one", server);
    await directory.register("account-two", { ...server, membershipId: "member-two" });
    expect(await directory.overview()).toHaveLength(2);
    await directory.setServerVisibleFromAdmin(server.hostId, false);
    expect(await directory.list("account-one")).toEqual([]);
    expect(await directory.list("account-two")).toEqual([]);
    expect((await directory.overview()).every((entry) => !entry.visible)).toBe(true);
  });
});
