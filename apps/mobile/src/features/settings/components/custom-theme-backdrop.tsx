import { Image } from "expo-image";
import { StyleSheet } from "react-native";

export function CustomThemeBackdrop({ imageUri, blur, opacity }: { imageUri: string; blur: number; opacity: number }) {
  return (
    <Image
      source={{ uri: imageUri }}
      contentFit="cover"
      blurRadius={blur}
      style={[StyleSheet.absoluteFill, { opacity: opacity / 100 }]}
      pointerEvents="none"
    />
  );
}
