import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CentralAuthOperationError } from "./central-auth-effects";
import { createRemoteTeamAuthTicket, redeemRemoteTeamAuthTicket } from "./remote-team-auth-ticket";

const success = (ticket: string) => Effect.succeed(ticket);

describe("createRemoteTeamAuthTicket", () => {
  it("does not issue a hosted ticket when local-only mode has no signed-in self-hosted account", async () => {
    const createSelfHostedTicket = vi.fn(() => success("self-hosted-ticket"));
    const createHostedTicket = vi.fn(() => success("hosted-ticket"));

    const result = await Effect.runPromise(
      Effect.result(
        createRemoteTeamAuthTicket(
          {
            localOnlyNetworking: true,
            selfHostedSignedIn: false,
            createSelfHostedTicket,
            createHostedTicket,
          },
          "team-server-1",
        ),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(CentralAuthOperationError);
      expect(result.failure.cause).toMatchObject({ message: "Sign in is required." });
    }
    expect(createSelfHostedTicket).not.toHaveBeenCalled();
    expect(createHostedTicket).not.toHaveBeenCalled();
  });

  it("issues the ticket from the self-hosted account authority in local-only mode", async () => {
    const createSelfHostedTicket = vi.fn(() => success("self-hosted-ticket"));
    const createHostedTicket = vi.fn(() => success("hosted-ticket"));

    await expect(
      Effect.runPromise(
        createRemoteTeamAuthTicket(
          {
            localOnlyNetworking: true,
            selfHostedSignedIn: true,
            createSelfHostedTicket,
            createHostedTicket,
          },
          "team-server-1",
        ),
      ),
    ).resolves.toBe("self-hosted-ticket");
    expect(createSelfHostedTicket).toHaveBeenCalledWith("team-server-1");
    expect(createHostedTicket).not.toHaveBeenCalled();
  });

  it("keeps hosted ticket creation in hosted mode", async () => {
    const createSelfHostedTicket = vi.fn(() => success("self-hosted-ticket"));
    const createHostedTicket = vi.fn(() => success("hosted-ticket"));

    await expect(
      Effect.runPromise(
        createRemoteTeamAuthTicket(
          {
            localOnlyNetworking: false,
            selfHostedSignedIn: false,
            createSelfHostedTicket,
            createHostedTicket,
          },
          "team-server-1",
        ),
      ),
    ).resolves.toBe("hosted-ticket");
    expect(createHostedTicket).toHaveBeenCalledWith("team-server-1");
    expect(createSelfHostedTicket).not.toHaveBeenCalled();
  });
});

describe("redeemRemoteTeamAuthTicket", () => {
  it("tries the local identity authority when the signed-in account authority does not recognize a legacy ticket", async () => {
    const redeemSelfHostedTicket = vi.fn(() => Effect.succeed(null));
    const redeemLocalTicket = vi.fn(() => Effect.succeed({ id: "local-member" }));
    const redeemHostedTicket = vi.fn(() => Effect.succeed({ id: "hosted-member" }));

    await expect(
      Effect.runPromise(
        redeemRemoteTeamAuthTicket(
          {
            localOnlyNetworking: true,
            selfHostedSignedIn: true,
            redeemSelfHostedTicket,
            redeemLocalTicket,
            redeemHostedTicket,
          },
          "legacy-ticket",
          "team-server-1",
        ),
      ),
    ).resolves.toEqual({ id: "local-member" });
    expect(redeemSelfHostedTicket).toHaveBeenCalledWith("legacy-ticket", "team-server-1");
    expect(redeemLocalTicket).toHaveBeenCalledWith("legacy-ticket", "team-server-1");
    expect(redeemHostedTicket).not.toHaveBeenCalled();
  });

  it("uses the local authority when the host has no signed-in account-server session", async () => {
    const redeemSelfHostedTicket = vi.fn(() => Effect.succeed({ id: "account-member" }));
    const redeemLocalTicket = vi.fn(() => Effect.succeed({ id: "local-member" }));

    await expect(
      Effect.runPromise(
        redeemRemoteTeamAuthTicket(
          {
            localOnlyNetworking: true,
            selfHostedSignedIn: false,
            redeemSelfHostedTicket,
            redeemLocalTicket,
            redeemHostedTicket: () => Effect.succeed(null),
          },
          "local-ticket",
          "team-server-1",
        ),
      ),
    ).resolves.toEqual({ id: "local-member" });
    expect(redeemSelfHostedTicket).not.toHaveBeenCalled();
    expect(redeemLocalTicket).toHaveBeenCalledWith("local-ticket", "team-server-1");
  });

  it("does not fall back after the signed-in authority reports a transport or session error", async () => {
    const redeemLocalTicket = vi.fn(() => Effect.succeed({ id: "local-member" }));
    const expected = new CentralAuthOperationError({ cause: new Error("Account session unavailable") });

    const result = await Effect.runPromise(
      Effect.result(
        redeemRemoteTeamAuthTicket(
          {
            localOnlyNetworking: true,
            selfHostedSignedIn: true,
            redeemSelfHostedTicket: () => Effect.fail(expected),
            redeemLocalTicket,
            redeemHostedTicket: () => Effect.succeed(null),
          },
          "ticket",
          "team-server-1",
        ),
      ),
    );

    expect(Result.isFailure(result)).toBe(true);
    if (Result.isFailure(result)) expect(result.failure).toBe(expected);
    expect(redeemLocalTicket).not.toHaveBeenCalled();
  });
});
