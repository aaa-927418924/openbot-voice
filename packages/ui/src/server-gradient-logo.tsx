import type { ServerGradientLogoProfile } from "@openbot/brand/server-gradient-logo";
import { serverGradientLogoProfile } from "@openbot/brand/server-gradient-logo";
import type { JSX } from "@solidjs/web";
import { createMemo } from "solid-js";
import { cx } from "./utils";

export { type ServerGradientLogoProfile, serverGradientLogoProfile };

export interface ServerGradientLogoProps {
  seed: string;
  class?: JSX.HTMLAttributes<HTMLSpanElement>["class"];
}

export function ServerGradientLogo(props: ServerGradientLogoProps): JSX.Element {
  const profile = createMemo<ServerGradientLogoProfile>(() => serverGradientLogoProfile(props.seed));

  return (
    <span
      class={cx("ui-server-gradient-logo", props.class)}
      style={{
        "--server-gradient-base": profile().colors[0],
        "--server-gradient-layers": profile().backgroundImage,
      }}
      aria-hidden="true"
    />
  );
}
