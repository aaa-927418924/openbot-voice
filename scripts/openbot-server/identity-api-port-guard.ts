import { createConnection } from "node:net";

/** Refuse a second identity API process before it opens the shared account store. */
export async function assertTcpPortAvailable(host: string, port: number): Promise<void> {
  const inUse = await new Promise<boolean>((resolve, reject) => {
    const socket = createConnection({ host, port });
    const timeout = setTimeout(() => {
      socket.destroy();
      reject(new Error("Could not verify the identity API port; no server state was changed."));
    }, 1_000);
    socket.once("connect", () => {
      clearTimeout(timeout);
      socket.destroy();
      resolve(true);
    });
    socket.once("error", (error: NodeJS.ErrnoException) => {
      clearTimeout(timeout);
      if (error.code === "ECONNREFUSED") resolve(false);
      else reject(new Error("Could not verify the identity API port; no server state was changed."));
    });
  });
  if (inUse) {
    throw new Error(
      "The identity API port is already in use. Close the OpenBot desktop host before configuring or starting the standalone server.",
    );
  }
}
