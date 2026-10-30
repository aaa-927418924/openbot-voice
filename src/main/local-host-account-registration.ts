export function canRegisterLocalHostForAccount(input: {
  signedInAccountId: string | null;
  ownerAccountId: string | null;
  localHostEnabled: boolean;
}): boolean {
  return (
    input.localHostEnabled &&
    input.signedInAccountId !== null &&
    input.ownerAccountId !== null &&
    input.signedInAccountId === input.ownerAccountId
  );
}
