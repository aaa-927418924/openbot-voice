import { File, Paths } from "expo-file-system";
import { Image } from "expo-image";
import { useVideoPlayer, VideoView } from "expo-video";
import { Button, Typography } from "heroui-native";
import { useEffect, useRef, useState } from "react";
import { ActivityIndicator, Modal, Platform, View } from "react-native";
import { useSafeAreaInsets } from "react-native-safe-area-context";
import { haptics } from "@/shared/lib/haptics";

export interface AttachmentPreview {
  name: string;
  /** A local image or video URI. Other files show their type and size instead. */
  uri: string | null;
  mimeType: string;
  base64?: string;
  type: string;
  size: string;
  loading?: boolean;
  status?: string | null;
}

export interface AttachmentPreviewAction {
  label: string;
  onPress: () => void;
  variant?: "secondary" | "danger-soft";
  disabled?: boolean;
}

/**
 * One attachment at full size, with what can be done to it. iOS presents a native page sheet
 * the user swipes away, and Android closes it with the system back action, so neither needs a
 * separate close button. An action closes the sheet first and runs once it is gone: iOS refuses
 * to present a picker or the share sheet from a sheet that is still leaving.
 */
export function AttachmentPreviewSheet({
  preview,
  actions,
  onClose,
}: {
  preview: AttachmentPreview | null;
  actions: AttachmentPreviewAction[];
  onClose: () => void;
}) {
  const insets = useSafeAreaInsets();
  const afterClose = useRef<(() => void) | null>(null);
  // The sheet slides away after `preview` clears, so it keeps drawing what it showed until then.
  const last = useRef(preview);
  if (preview) last.current = preview;
  const shown = preview ?? last.current;
  function run(action: AttachmentPreviewAction) {
    void haptics.selection();
    if (Platform.OS === "ios") {
      afterClose.current = action.onPress;
      onClose();
    } else {
      onClose();
      action.onPress();
    }
  }
  return (
    <Modal
      visible={preview !== null}
      animationType="slide"
      presentationStyle="pageSheet"
      onRequestClose={onClose}
      onDismiss={() => {
        const action = afterClose.current;
        afterClose.current = null;
        action?.();
      }}
    >
      {shown ? (
        <View className="flex-1 bg-background" style={{ paddingBottom: Math.max(insets.bottom, 16) }}>
          <View className="gap-0.5 px-5 pt-5 pb-3">
            <Typography.Paragraph numberOfLines={2} className="font-semibold text-foreground">
              {shown.name}
            </Typography.Paragraph>
            <Typography.Paragraph type="body-sm" className="text-muted">
              {`${shown.type} · ${shown.size}`}
            </Typography.Paragraph>
          </View>
          {shown.mimeType.startsWith("video/") ? (
            shown.uri || shown.base64 ? (
              <VideoPreview
                key={shown.uri ?? shown.name}
                uri={shown.uri}
                base64={shown.base64}
                active={preview !== null}
              />
            ) : (
              <View className="flex-1 items-center justify-center gap-3">
                {shown.loading ? <ActivityIndicator size="large" /> : null}
                <Typography.Paragraph className="text-muted">{shown.status ?? shown.type}</Typography.Paragraph>
              </View>
            )
          ) : shown.uri ? (
            <Image
              source={shown.uri}
              contentFit="contain"
              accessibilityLabel={shown.name}
              style={{ flex: 1 }}
              transition={0}
            />
          ) : (
            <View className="flex-1 items-center justify-center">
              <View className="size-24 items-center justify-center rounded-3xl bg-success/15">
                <Typography.Heading type="h4" className="text-success-text">
                  {shown.type}
                </Typography.Heading>
              </View>
            </View>
          )}
          <View className="flex-row gap-3 px-5 pt-4">
            {actions.map((action) => (
              <Button
                key={action.label}
                className="flex-1"
                variant={action.variant ?? "secondary"}
                isDisabled={action.disabled}
                onPress={() => run(action)}
              >
                <Button.Label>{action.label}</Button.Label>
              </Button>
            ))}
          </View>
        </View>
      ) : null}
    </Modal>
  );
}

function VideoPreview({ uri, base64, active }: { uri: string | null; base64?: string; active: boolean }) {
  const [resolvedUri, setResolvedUri] = useState<string | null>(uri);
  const temporary = useRef<File | null>(null);
  useEffect(() => {
    if (uri) {
      setResolvedUri(uri);
      return;
    }
    if (!base64) {
      setResolvedUri(null);
      return;
    }
    const file = new File(Paths.cache, `openbot-video-preview-${Date.now()}.mp4`);
    file.write(base64, { encoding: "base64" });
    temporary.current = file;
    setResolvedUri(file.uri);
    return () => {
      if (temporary.current === file && file.exists) file.delete();
      if (temporary.current === file) temporary.current = null;
    };
  }, [uri, base64]);
  return resolvedUri ? <VideoPlayer uri={resolvedUri} active={active} /> : <ActivityIndicator size="large" />;
}

function VideoPlayer({ uri, active }: { uri: string; active: boolean }) {
  const player = useVideoPlayer(uri);
  useEffect(() => {
    if (!active) player.pause();
  }, [active, player]);
  return <VideoView player={player} contentFit="contain" nativeControls style={{ flex: 1 }} />;
}
