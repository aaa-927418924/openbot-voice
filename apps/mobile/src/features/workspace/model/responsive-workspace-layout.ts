export type ResponsiveWorkspaceLayout = "compact" | "two-pane" | "three-pane";

const TWO_PANE_MIN_WIDTH = 760;
const THREE_PANE_MIN_WIDTH = 1180;

export function responsiveWorkspaceLayout(width: number, ios: boolean): ResponsiveWorkspaceLayout {
  if (!ios || width < TWO_PANE_MIN_WIDTH) return "compact";
  if (width < THREE_PANE_MIN_WIDTH) return "two-pane";
  return "three-pane";
}
