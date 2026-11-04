export function canRegisterHostForAccount(input: {
  signedInAccountId: string | null;
  ownerAccountId: string | null;
  hostPublished: boolean;
}): boolean {
  return (
    input.hostPublished &&
    input.signedInAccountId !== null &&
    input.ownerAccountId !== null &&
    input.signedInAccountId === input.ownerAccountId
  );
}
