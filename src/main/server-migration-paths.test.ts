import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { serverMigrationSourceStagingRoot } from "./server-migration-paths";

describe("serverMigrationSourceStagingRoot", () => {
  it("uses a sibling of userData outside both migration source roots", () => {
    const home = join(tmpdir(), "openbot-migration-paths");

    expect(
      serverMigrationSourceStagingRoot(join(home, ".config", "OpenBot"), join(home, "OpenBot"), join(home, "tmp")),
    ).toBe(join(home, ".config", ".OpenBot-server-migration-source-staging"));
  });

  it("falls back to temp when the userData sibling is inside the workspace", () => {
    const root = join(tmpdir(), "openbot-migration-paths");

    expect(
      serverMigrationSourceStagingRoot(
        join(root, "workspace", "profile", "OpenBot"),
        join(root, "workspace"),
        join(root, "temp"),
      ),
    ).toBe(join(root, "temp", "openbot-server-migration-source-staging"));
  });

  it("fails closed if both candidate locations overlap the source roots", () => {
    const root = join(tmpdir(), "openbot-migration-paths");

    expect(() => serverMigrationSourceStagingRoot(join(root, "profile"), root, join(root, "temp"))).toThrow(
      "outside the source data roots",
    );
  });
});
