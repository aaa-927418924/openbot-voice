import type { TeamMemberSummary } from "@openbot/contracts/ipc";
import { describe, expect, it } from "vitest";
import { buildMemberIdMap } from "./server-migration-source";

function member(id: string, email: string | null, role: TeamMemberSummary["role"] = "member"): TeamMemberSummary {
  return {
    id,
    username: id,
    email,
    name: id,
    role,
    createdAt: "2026-01-01T00:00:00.000Z",
    disabled: false,
  };
}

describe("buildMemberIdMap", () => {
  it("maps the source owner to the destination owner and other members by email", () => {
    const mapping = buildMemberIdMap(
      "source-owner",
      [member("source-owner", "owner@example.com", "owner"), member("alice", "Alice@Example.com"), member("bob", null)],
      [member("destination-owner", "owner@example.com", "owner"), member("alice-2", "alice@example.com")],
    );

    expect([...mapping.entries()]).toEqual([
      ["source-owner", "destination-owner"],
      ["alice", "alice-2"],
    ]);
  });

  it("leaves a member with no destination counterpart under the source identity", () => {
    const mapping = buildMemberIdMap(
      "source-owner",
      [member("source-owner", null, "owner"), member("carol", "c@x")],
      [member("destination-owner", "owner@example.com", "owner")],
    );

    expect([...mapping.entries()]).toEqual([["source-owner", "destination-owner"]]);
    expect(mapping.has("carol")).toBe(false);
  });

  it("uses the destination member that matches a source email", () => {
    const mapping = buildMemberIdMap(
      "source-owner",
      [
        member("source-owner", null, "owner"),
        member("first", "same@example.com"),
        member("second", "same@example.com"),
      ],
      [member("destination-owner", null, "owner"), member("only-one", "same@example.com")],
    );

    expect(mapping.get("first")).toBe("only-one");
    expect(mapping.get("second")).toBe("only-one");
  });
});
