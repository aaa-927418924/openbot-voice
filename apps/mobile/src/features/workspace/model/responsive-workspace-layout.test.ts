import { expect, it } from "vitest";
import { responsiveWorkspaceLayout } from "./responsive-workspace-layout";

it("uses the existing compact layout on Android and narrow iOS windows", () => {
  expect(responsiveWorkspaceLayout(1400, false)).toBe("compact");
  expect(responsiveWorkspaceLayout(759, true)).toBe("compact");
});

it("shows two panes in a wide phone or a portrait iPad window", () => {
  expect(responsiveWorkspaceLayout(760, true)).toBe("two-pane");
  expect(responsiveWorkspaceLayout(1179, true)).toBe("two-pane");
});

it("shows the server rail, Bot list, and chat at desktop-class iPad widths", () => {
  expect(responsiveWorkspaceLayout(1180, true)).toBe("three-pane");
});
