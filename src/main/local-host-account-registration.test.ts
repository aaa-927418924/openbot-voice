import { describe, expect, it } from "vitest";
import { canRegisterLocalHostForAccount } from "./local-host-account-registration";

describe("local host account registration", () => {
  it("only publishes an enabled host under the account that owns it", () => {
    expect(
      canRegisterLocalHostForAccount({
        signedInAccountId: "account-new",
        ownerAccountId: "account-old",
        localHostEnabled: true,
      }),
    ).toBe(false);
    expect(
      canRegisterLocalHostForAccount({
        signedInAccountId: "account-owner",
        ownerAccountId: "account-owner",
        localHostEnabled: true,
      }),
    ).toBe(true);
    expect(
      canRegisterLocalHostForAccount({
        signedInAccountId: "account-owner",
        ownerAccountId: "account-owner",
        localHostEnabled: false,
      }),
    ).toBe(false);
  });
});
