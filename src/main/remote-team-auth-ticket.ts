import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { CentralAuthOperationError } from "./central-auth-effects";

type RemoteTeamAuthTicketDependencies = {
  readonly localOnlyNetworking: boolean;
  readonly selfHostedSignedIn: boolean;
  readonly createSelfHostedTicket: (serverId: string) => Effect.Effect<string, CentralAuthOperationError>;
  readonly createHostedTicket: (serverId: string) => Effect.Effect<string, CentralAuthOperationError>;
};

/** Create a ticket from the account authority that owns the signed-in session. */
export function createRemoteTeamAuthTicket(
  dependencies: RemoteTeamAuthTicketDependencies,
  serverId: string,
): Effect.Effect<string, CentralAuthOperationError> {
  if (!dependencies.localOnlyNetworking) return dependencies.createHostedTicket(serverId);
  if (!dependencies.selfHostedSignedIn) {
    return Effect.fail(new CentralAuthOperationError({ cause: new Error(sourceText("error.auth.signInRequired")) }));
  }
  return dependencies.createSelfHostedTicket(serverId);
}
