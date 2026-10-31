import { Effect, Result } from "effect";
import { describe, expect, it, vi } from "vitest";
import { CentralAuthOperationError } from "./central-auth-effects";
import { createRemoteTeamAuthTicket } from "./remote-team-auth-ticket";

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
