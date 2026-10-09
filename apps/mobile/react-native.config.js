// Live Voice needs WebChromeClient.onPermissionRequest to grant Android's
// getUserMedia audio capture request after RECORD_AUDIO is approved.
// Expo DOM WebView stays in use on iOS.
module.exports = {
  dependencies: {
    "react-native-webview": { platforms: { ios: null } },
  },
};
