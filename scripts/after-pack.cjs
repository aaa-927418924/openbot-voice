const { chmod, chown } = require("node:fs/promises");
const { join } = require("node:path");

module.exports = async ({ appOutDir, electronPlatformName }) => {
  if (electronPlatformName === "linux") {
    const sandboxPath = join(appOutDir, "chrome-sandbox");
    if (process.getuid?.() === 0 || process.env.OPENBOT_APPIMAGE_FAKEROOT === "1") {
      await chown(sandboxPath, 0, 0);
    }
    await chmod(sandboxPath, 0o4755);
  }
};
