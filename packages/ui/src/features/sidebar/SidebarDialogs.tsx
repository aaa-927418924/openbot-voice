/** The sidebar's agent, channel and section confirmations share one pending delete state. */

import { ConfirmDialog } from "@openbot/ui";
import { Show } from "solid-js";
import { useText } from "../../text";
import { AgentAvatar } from "../agents/AgentAvatar";
import { ChannelAvatar } from "../channels/ChannelAvatar";
import { useSidebarScope } from "./sidebar-scope";

export function SidebarDialogs() {
  const {
    closeDelete,
    confirmDelete,
    confirmClearHistory,
    confirmClearChannelHistory,
    confirmSectionDelete,
    deleteError,
    deleteTargetIsHistory,
    deleteTarget,
    channelDeleteTarget,
    channelHistoryDeleteTarget,
    deleting,
    props,
    sectionDeleteTarget,
  } = useSidebarScope();
  const { t } = useText();
  const shared = {
    get confirmLabel() {
      return t("common.delete");
    },
    get pendingLabel() {
      return t("sidebar.delete.pending");
    },
    onCancel: closeDelete,
  };
  // Each dialog unmounts with its target, so its text never shows an empty name while it closes.
  return (
    <>
      <Show when={deleteTarget()}>
        {(agent) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            media={<AgentAvatar agent={agent()} style={{ width: "44px", height: "44px" }} />}
            title={t(deleteTargetIsHistory() ? "sidebar.clearHistory.title" : "sidebar.delete.title", {
              name: agent().name,
            })}
            description={t(
              deleteTargetIsHistory() ? "sidebar.clearHistory.description" : "sidebar.delete.agentDescription",
            )}
            confirmLabel={deleteTargetIsHistory() ? t("sidebar.clearHistory.confirm") : shared.confirmLabel}
            onConfirm={deleteTargetIsHistory() ? confirmClearHistory : confirmDelete}
          />
        )}
      </Show>

      <Show when={channelDeleteTarget()}>
        {(channel) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            media={<ChannelAvatar members={channel().members} agents={props.agents} layout="cluster" />}
            title={t("sidebar.delete.title", { name: channel().name })}
            description={t("sidebar.delete.channelDescription")}
            onConfirm={confirmDelete}
          />
        )}
      </Show>

      <Show when={channelHistoryDeleteTarget()}>
        {(channel) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            media={<ChannelAvatar members={channel().members} agents={props.agents} layout="cluster" />}
            title={t("channel.history.clearTitle", { name: channel().name })}
            description={t("channel.history.clearDescription")}
            confirmLabel={t("channel.history.clearConfirm")}
            onConfirm={confirmClearChannelHistory}
          />
        )}
      </Show>

      <Show when={sectionDeleteTarget()}>
        {(section) => (
          <ConfirmDialog
            {...shared}
            open
            pending={deleting()}
            error={deleteError()}
            title={t("sidebar.delete.title", { name: section().name })}
            description={t("sidebar.delete.sectionDescription")}
            onConfirm={confirmSectionDelete}
          />
        )}
      </Show>
    </>
  );
}
