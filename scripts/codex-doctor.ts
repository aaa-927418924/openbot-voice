import { Effect } from "effect";
import { CodexAppServerClient } from "../src/backend/app-server-client";
import { resolveCodexCli } from "../src/backend/cli";
import { CodexHome } from "../src/backend/codex-home";
import { runCauseEffect } from "../src/backend/effect-boundary";
import { decodeAccountReadResult, decodeRecordResponse } from "../src/backend/protocol";

const strict = process.argv.includes("--strict");
// The app's userData directory, so doctor checks the fork's dedicated Codex home instead of
// the ambient ~/.codex. Omitted keeps the legacy behavior for CI (`test:codex`).
const userDataFlag = process.argv.findIndex((argument) => argument === "--user-data");
const userDataPath = userDataFlag === -1 ? process.env.OPENBOT_USER_DATA : process.argv[userDataFlag + 1];
const codexHome = userDataPath ? new CodexHome({ userDataPath }).ensure() : undefined;
if (!codexHome) process.stdout.write("No --user-data given: checking the ambient Codex home.\n");
let client: CodexAppServerClient | null = null;

try {
  const cli = await runCauseEffect(resolveCodexCli());
  client = new CodexAppServerClient(cli.executable, 10_000, codexHome);
  client.start();
  await runCauseEffect(
    client.request(
      "initialize",
      {
        clientInfo: { name: "openbot_doctor", title: "OpenBot Doctor", version: "0.1.0" },
        capabilities: { experimentalApi: true },
      },
      decodeRecordResponse,
    ),
  );
  client.notify("initialized");

  const account = await runCauseEffect(
    client.request("account/read", { refreshToken: false }, decodeAccountReadResult),
  );
  const auth = account.account
    ? {
        type: account.account.type,
        planType: account.account.type === "chatgpt" ? (account.account.planType ?? null) : null,
      }
    : null;

  // Machine-readable: doctor result JSON consumed by tooling.
  process.stdout.write(
    `${JSON.stringify(
      {
        ok: account.account?.type === "chatgpt",
        executable: cli.executable,
        cliVersion: cli.version,
        appServer: "ready",
        codexHome: codexHome ?? null,
        auth,
      },
      null,
      2,
    )}\n`,
  );

  if (strict && account.account?.type !== "chatgpt") process.exitCode = 1;
} catch (error) {
  // Machine-readable: doctor failure JSON consumed by tooling.
  process.stderr.write(
    `${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) }, null, 2)}\n`,
  );
  process.exitCode = 1;
} finally {
  if (client) await Effect.runPromise(client.stop());
}
