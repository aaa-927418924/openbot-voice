// @vitest-environment node
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Effect } from "effect";
import { afterEach, describe, expect, it } from "vitest";
import { SelfHostedIdentityAuthority, type SelfHostedIdentityFailure } from "./self-hosted-identity-authority";

const roots: string[] = [];
const password = "local-secret-password-58";
const profile = {
  id: "existing-local-profile-id",
  name: "Main account",
  avatarUrl: `data:image/png;base64,${Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]).toString("base64")}`,
};

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

async function newAuthority(now: () => number = () => 1_800_000_000_000) {
  const root = await mkdtemp(join(tmpdir(), "openbot-identity-authority-"));
  roots.push(root);
  const path = join(root, "identity.json");
  const authority = new SelfHostedIdentityAuthority({ path, now });
  await Effect.runPromise(authority.initialize());
  return { authority, path };
}

async function bootstrap(authority: SelfHostedIdentityAuthority) {
  return Effect.runPromise(
    authority.bootstrapFirstAccount({
      remoteAddress: "127.0.0.1",
      username: "main.owner",
      password,
      profile,
    }),
  );
}

async function failureCode(operation: Effect.Effect<unknown, SelfHostedIdentityFailure>) {
  return Effect.runPromise(Effect.flip(operation));
}

function runEffect<A>(operation: Effect.Effect<A, SelfHostedIdentityFailure>): Promise<A> {
  return Effect.runPromise(operation);
}

describe("SelfHostedIdentityAuthority", () => {
  it("creates one canonical account from the existing local profile and does not replace it on later boots", async () => {
    const { authority } = await newAuthority();
    const first = await runEffect(authority.ensureLocalAccount(profile));
    const later = await runEffect(authority.ensureLocalAccount({ ...profile, name: "A different device name" }));

    expect(first).toMatchObject({ id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl });
    expect(later).toEqual(first);
    expect(authority.getLocalAccount()).toEqual(first);
  });

  it("binds mobile pairing tickets to the host fingerprint and consumes them once", async () => {
    const { authority, path } = await newAuthority();
    const account = await runEffect(authority.ensureLocalAccount(profile));
    const input = {
      accountId: account.id,
      hostId: "linux-host-id",
      fingerprint: "f".repeat(43),
    };
    const rejectedTicket = await runEffect(authority.issueMobileConnectTicket(input));
    await expect(
      runEffect(
        authority.redeemMobileConnectTicket({
          ticket: rejectedTicket.ticket,
          hostId: input.hostId,
          fingerprint: "x".repeat(43),
          deviceId: "device-id-1",
          deviceName: "Pixel 7a",
          platform: "android",
        }),
      ),
    ).resolves.toBeNull();
    await expect(
      runEffect(
        authority.redeemMobileConnectTicket({
          ticket: rejectedTicket.ticket,
          hostId: input.hostId,
          fingerprint: input.fingerprint,
          deviceId: "device-id-1",
          deviceName: "Pixel 7a",
          platform: "android",
        }),
      ),
    ).resolves.toBeNull();

    const ticket = await runEffect(authority.issueMobileConnectTicket(input));
    const session = await runEffect(
      authority.redeemMobileConnectTicket({
        ticket: ticket.ticket,
        hostId: input.hostId,
        fingerprint: input.fingerprint,
        deviceId: "device-id-1",
        deviceName: "Pixel 7a",
        platform: "android",
      }),
    );
    expect(session?.account).toEqual(account);
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored.sessions).toHaveLength(1);
    expect(stored.sessions[0]).toMatchObject({ deviceId: "device-id-1", deviceName: "Pixel 7a", platform: "android" });
    expect(JSON.stringify(stored)).not.toContain(session?.token);
    await expect(
      runEffect(
        authority.redeemMobileConnectTicket({
          ticket: ticket.ticket,
          hostId: input.hostId,
          fingerprint: input.fingerprint,
          deviceId: "device-id-1",
          deviceName: "Pixel 7a",
          platform: "android",
        }),
      ),
    ).resolves.toBeNull();
  });

  it("bootstraps once from loopback and keeps the existing local profile identity", async () => {
    const { authority, path } = await newAuthority();

    await expect(
      failureCode(
        authority.bootstrapFirstAccount({
          remoteAddress: "100.100.10.2",
          username: "main.owner",
          password,
          profile,
        }),
      ),
    ).resolves.toMatchObject({ code: "loopback_required" });

    const account = await bootstrap(authority);
    expect(account).toEqual({
      id: profile.id,
      username: "main.owner",
      email: "",
      name: profile.name,
      avatarUrl: profile.avatarUrl,
    });
    await expect(
      failureCode(
        authority.bootstrapFirstAccount({
          remoteAddress: "127.0.0.1",
          username: "main.owner",
          password,
          profile,
        }),
      ),
    ).resolves.toMatchObject({ code: "setup_completed" });

    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored.accounts[0]).toMatchObject({ id: profile.id, name: profile.name, avatarUrl: profile.avatarUrl });
    expect(JSON.stringify(stored)).not.toContain(password);
  });

  it("adds email login without changing the local account ID or profile", async () => {
    const { authority, path } = await newAuthority();
    const original = await runEffect(authority.ensureLocalAccount(profile));
    const configured = await runEffect(
      authority.configureLoginCredentials({ email: "Owner@OpenBot.test", password: "central-password-123" }),
    );
    const session = await runEffect(
      authority.signIn({
        username: "OWNER@openbot.test",
        password: "central-password-123",
        deviceId: "main-pc-id",
        deviceName: "Main PC",
        platform: "unknown",
      }),
    );

    expect(configured).toMatchObject({
      id: original.id,
      name: original.name,
      avatarUrl: original.avatarUrl,
      email: "owner@openbot.test",
    });
    expect(session.account.id).toBe(original.id);
    expect(await runEffect(authority.listActiveDeviceSessions())).toMatchObject([
      { deviceName: "Main PC", platform: "unknown" },
    ]);
    const stored = await readFile(path, "utf8");
    expect(stored).toContain("owner@openbot.test");
    expect(stored).not.toContain("central-password-123");
  });

  it("stores only a session token hash and revokes the session", async () => {
    const { authority, path } = await newAuthority();
    await bootstrap(authority);

    const grant = await runEffect(authority.signIn({ username: "MAIN.OWNER", password }));
    const stored = JSON.parse(await readFile(path, "utf8"));
    expect(stored.sessions).toHaveLength(1);
    expect(stored.accounts[0].passwordSalt).toMatch(/^[A-Za-z0-9_-]{22}$/u);
    expect(stored.accounts[0].passwordHash).toMatch(/^[A-Za-z0-9_-]{86}$/u);
    expect(stored.sessions[0].tokenHash).toBe(createHash("sha256").update(grant.token).digest("base64url"));
    expect(JSON.stringify(stored)).not.toContain(grant.token);
    expect(JSON.stringify(stored)).not.toContain(password);
    await expect(
      failureCode(authority.signIn({ username: "main.owner", password: "incorrect-password-99" })),
    ).resolves.toMatchObject({ code: "invalid_credentials" });
    expect(await runEffect(authority.authenticateSession(grant.token))).toEqual(grant.account);

    expect(await runEffect(authority.revokeSession(grant.token))).toBe(true);
    expect(await runEffect(authority.authenticateSession(grant.token))).toBeNull();
    expect(await runEffect(authority.revokeSession(grant.token))).toBe(false);
  });

  it("binds team tickets to one host and consumes them once", async () => {
    const { authority } = await newAuthority();
    await bootstrap(authority);
    const session = await runEffect(authority.signIn({ username: "main.owner", password }));

    const wrongHostTicket = await runEffect(
      authority.issueTeamTicket({ sessionToken: session.token, targetTeamServerId: "team-server-a" }),
    );
    expect(
      await runEffect(
        authority.consumeTeamTicket({ ticket: wrongHostTicket.ticket, targetTeamServerId: "team-server-b" }),
      ),
    ).toBeNull();
    expect(
      await runEffect(
        authority.consumeTeamTicket({ ticket: wrongHostTicket.ticket, targetTeamServerId: "team-server-a" }),
      ),
    ).toBeNull();

    const ticket = await runEffect(
      authority.issueTeamTicket({ sessionToken: session.token, targetTeamServerId: "team-server-a" }),
    );
    expect(
      await runEffect(authority.consumeTeamTicket({ ticket: ticket.ticket, targetTeamServerId: "team-server-a" })),
    ).toEqual(session.account);
    expect(
      await runEffect(authority.consumeTeamTicket({ ticket: ticket.ticket, targetTeamServerId: "team-server-a" })),
    ).toBeNull();
  });

  it("expires a team ticket and a session at their stored deadlines", async () => {
    let now = 1_800_000_000_000;
    const { authority } = await newAuthority(() => now);
    await bootstrap(authority);
    const session = await runEffect(authority.signIn({ username: "main.owner", password }));
    const ticket = await runEffect(
      authority.issueTeamTicket({ sessionToken: session.token, targetTeamServerId: "team-server-a" }),
    );

    now = ticket.expiresAt;
    expect(
      await runEffect(authority.consumeTeamTicket({ ticket: ticket.ticket, targetTeamServerId: "team-server-a" })),
    ).toBeNull();
    expect(await runEffect(authority.authenticateSession(session.token))).toEqual(session.account);

    now = session.expiresAt;
    expect(await runEffect(authority.authenticateSession(session.token))).toBeNull();
  });

  it("does not replace an unreadable identity file", async () => {
    const root = await mkdtemp(join(tmpdir(), "openbot-identity-corrupt-"));
    roots.push(root);
    const path = join(root, "identity.json");
    await writeFile(path, "{not-json", "utf8");
    const authority = new SelfHostedIdentityAuthority({ path });

    await expect(failureCode(authority.initialize())).resolves.toMatchObject({ code: "storage_unavailable" });
    expect(await readFile(path, "utf8")).toBe("{not-json");
  });
});
