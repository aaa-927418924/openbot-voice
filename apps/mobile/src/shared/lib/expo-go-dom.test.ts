import { describe, expect, it } from "vitest";
import { androidReactNativeDomOptions } from "./expo-go-dom";

describe("Android React Native DOM options", () => {
  it("restores Expo host values before the DOM bundle starts", () => {
    expect(androidReactNativeDomOptions.useExpoDOMWebView).toBe(false);
    expect(androidReactNativeDomOptions.injectedJavaScriptBeforeContentLoaded).toContain(
      "window.ReactNativeWebView.injectedObjectJson()",
    );
    expect(androidReactNativeDomOptions.injectedJavaScriptBeforeContentLoaded).toContain('keep("$$EXPO_INITIAL_PROPS"');
  });
});
