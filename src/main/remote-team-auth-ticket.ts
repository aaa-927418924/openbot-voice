import { sourceText } from "@openbot/i18n/source";
import { Effect } from "effect";
import { CentralAuthOperationError } from "./central-auth-effects";

type RemoteTeamAuthTicketDependencies = {
  readonly localOnlyNetworking: boolean;
  readonly selfHostedSignedIn: boolean;
  readonly createSelfHostedTicket: (serverId: string) => Effect.Effect<string, CentralAuthOperationError>;
  readonly createHostedTicket: (serverId: string) => Effect.Effect<string, CentralAuthOperationError>;
};

export interface RedeemRemoteTeamAuthTicketDependencies<A, E> {
  readonly localOnlyNetworking: boolean;
  readonly selfHostedSignedIn: boolean;
  readonly redeemSelfHostedTicket?: (ticket: string, serverId: string) => Effect.Effect<A | null, E>;
  readonly redeemLocalTicket?: (ticket: string, serverId: string) => Effect.Effect<A | null, E>;
  readonly redeemHostedTicket: (ticket: string, serverId: string) => Effect.Effect<A | null, E>;
}

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

/** Redeem through the signed-in account authority, then accept an older ticket from this host's local authority. */
export function redeemRemoteTeamAuthTicket<A, E>(
  dependencies: RedeemRemoteTeamAuthTicketDependencies<A, E>,
  ticket: string,
  serverId: string,
): Effect.Effect<A | null, E> {
  if (!dependencies.localOnlyNetworking) return dependencies.redeemHostedTicket(ticket, serverId);
  const localRedemption = Effect.suspend(
    () => dependencies.redeemLocalTicket?.(ticket, serverId) ?? Effect.succeed(null),
  );
  if (!dependencies.selfHostedSignedIn || !dependencies.redeemSelfHostedTicket) return localRedemption;
  return dependencies
    .redeemSelfHostedTicket(ticket, serverId)
    .pipe(Effect.flatMap((account) => (account ? Effect.succeed(account) : localRedemption)));
}
