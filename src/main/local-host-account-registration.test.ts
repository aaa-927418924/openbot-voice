import { describe, expect, it } from "vitest";
import { canRegisterHostForAccount } from "./local-host-account-registration";

describe("host account registration", () => {
  it("only publishes a shared host under the account that owns it", () => {
    expect(
      canRegisterHostForAccount({
        signedInAccountId: "account-new",
        ownerAccountId: "account-old",
        hostPublished: true,
      }),
    ).toBe(false);
    expect(
      canRegisterHostForAccount({
        signedInAccountId: "account-owner",
        ownerAccountId: "account-owner",
        hostPublished: true,
      }),
    ).toBe(true);
    expect(
      canRegisterHostForAccount({
        signedInAccountId: "account-owner",
        ownerAccountId: "account-owner",
        hostPublished: false,
      }),
    ).toBe(false);
  });
});
