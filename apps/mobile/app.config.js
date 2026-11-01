/** @param {{ config: import("expo/config").ExpoConfig }} context */
export default ({ config }) => {
  const baseConfig = {
    ...config,
    name: config.name ?? "OpenBot",
    slug: config.slug ?? "openbot",
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
