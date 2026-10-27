import { redirectIncomingLink } from "@/features/links/model/incoming-links";
import { isLiveActivityLink, liveActivityRoute } from "@/features/live-activity/model/live-activity-link";

export function redirectSystemPath({ path, initial }: { path: string; initial: boolean }) {
  try {
    if (isLiveActivityLink(path)) return liveActivityRoute(path, initial);
    return redirectIncomingLink(path);
  } catch {
    return "/incoming-link";
  }
}
