import { File, Paths } from "expo-file-system";
import * as Sharing from "expo-sharing";

import { supportLogFileText } from "./support-log-capture";

/** Shares the local redacted log only after an explicit user action. */
export async function shareSupportLog(dialogTitle: string): Promise<boolean> {
  if (!(await Sharing.isAvailableAsync())) return false;
  const file = new File(Paths.cache, `openbot-support-log-${new Date().toISOString().replace(/[:.]/gu, "-")}.txt`);
  try {
    file.write(supportLogFileText());
    await Sharing.shareAsync(file.uri, {
      mimeType: "text/plain",
      UTI: "public.plain-text",
      dialogTitle,
    });
    return true;
  } finally {
    if (file.exists) file.delete();
  }
}
