import { ConfirmDialog, IconButton, Trash2 } from "@openbot/ui";
import { useText } from "@openbot/ui/text";
import { createSignal, Show } from "solid-js";

export function ChannelHistoryControls(props: {
  channelName: string;
  supported: boolean;
  archived: boolean;
  pending: boolean;
  error?: string;
  onClear: () => Promise<boolean>;
}) {
  const { t } = useText();
  const [confirmOpen, setConfirmOpen] = createSignal(false);
  return (
    <>
      <Show when={props.supported && !props.archived}>
        <IconButton
          variant="ghost"
          label={t("channel.history.clear")}
          disabled={props.pending}
          onClick={() => setConfirmOpen(true)}
        >
          <Trash2 aria-hidden="true" />
        </IconButton>
      </Show>
      <ConfirmDialog
        open={confirmOpen()}
        onCancel={() => setConfirmOpen(false)}
        onConfirm={async () => {
          if (await props.onClear()) setConfirmOpen(false);
        }}
        title={t("channel.history.clearTitle", { name: props.channelName })}
        description={t("channel.history.clearDescription")}
        confirmLabel={t("channel.history.clearConfirm")}
        pending={props.pending}
        error={props.error}
        initialFocus="cancel"
      />
    </>
  );
}
