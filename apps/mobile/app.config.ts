import type { ConfigContext, ExpoConfig } from "expo/config";
import appJson from "./app.json";

export default ({ config }: ConfigContext): ExpoConfig => {
  const baseConfig: ExpoConfig = {
    ...config,
    name: config.name ?? appJson.expo.name,
    slug: config.slug ?? appJson.expo.slug,
  };

  if (process.env.OPENBOT_ANDROID_APK_VARIANT !== "voice") return baseConfig;

  return {
    ...baseConfig,
    name: "OpenBot Voice",
    scheme: ["openbotvoice", "openbot"],
    android: {
      ...baseConfig.android,
      package: "com.aaa927418924.openbotvoice",
    },
  };
};
