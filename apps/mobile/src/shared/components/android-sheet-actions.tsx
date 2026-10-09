import { Button, Typography } from "heroui-native";
import { useThemeColor } from "heroui-native/hooks";
import { X } from "lucide-react-native";
import { View } from "react-native";

export function AndroidSheetActions({
  title,
  closeLabel,
  actionLabel,
  pendingLabel,
  disabled,
  pending,
  onClose,
  onAction,
}: {
  title: string;
  closeLabel: string;
  actionLabel: string;
  pendingLabel: string;
  disabled: boolean;
  pending: boolean;
  onClose: () => void;
  onAction: () => void;
}) {
  const foreground = String(useThemeColor("foreground"));
  const label = pending ? pendingLabel : actionLabel;

  return (
    <View className="flex-row items-center gap-3 border-b border-grouped-border bg-sheet px-4 py-2">
      <Button isIconOnly variant="ghost" className="size-11" accessibilityLabel={closeLabel} onPress={onClose}>
        <X color={foreground} size={22} strokeWidth={1.9} />
      </Button>
      <Typography.Heading type="h4" className="min-w-0 flex-1" numberOfLines={1}>
        {title}
      </Typography.Heading>
      <Button
        size="sm"
        variant="primary"
        isDisabled={disabled || pending}
        accessibilityLabel={label}
        onPress={onAction}
      >
        <Button.Label>{label}</Button.Label>
      </Button>
    </View>
  );
}
