// @vitest-environment node
import { mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { ATTACHMENT_LIMITS } from "@openbot/contracts/input-limits";
import type { AttachmentSummary } from "@openbot/contracts/ipc";
import { TEAM_VIDEO_ATTACHMENTS_CAPABILITY } from "@openbot/contracts/team-protocol/current";
import { translateFor } from "@openbot/i18n";
import { Effect } from "effect";
import { strFromU8, unzipSync } from "fflate";
import { afterEach, describe, expect, it, vi } from "vitest";
import { runCauseEffect } from "../../backend/effect-boundary";

type Invoke = (event: { senderFrame: { url: string } }, payload: unknown) => Promise<void>;
const { bound, saveDialog, showOpenDialog, openPath, showItemInFolder, userData } = vi.hoisted(() => ({
  bound: new Map<string, Invoke>(),
  saveDialog: vi.fn<(options?: unknown) => Promise<{ canceled: boolean; filePath?: string }>>(),
  showOpenDialog: vi.fn<(options?: unknown) => Promise<{ canceled: boolean; filePaths: string[] }>>(),
  openPath: vi.fn(async (_path: string) => ""),
  showItemInFolder: vi.fn((_path: string) => undefined),
  userData: { path: "" },
}));
vi.mock("electron", () => ({
  app: { getPath: () => userData.path || tmpdir() },
  dialog: { showSaveDialog: saveDialog, showOpenDialog },
  shell: { openPath, showItemInFolder },
  ipcMain: { handle: (channel: string, invoke: Invoke) => bound.set(channel, invoke) },
}));
const { AttachmentArchiveFailed, saveAttachmentArchive, attachmentIpcHandlers } = await import("./attachment-handlers");
const directories: string[] = [];
afterEach(async () => {
  userData.path = "";
  saveDialog.mockClear();
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function destination() {
  const directory = await mkdtemp(join(tmpdir(), "attachment-zip-"));
  directories.push(directory);
  return join(directory, "attachments.zip");
}
const input = {
  attachments: [
    { id: "one", name: "../report.txt" },
    { id: "two", name: "folder\\report.txt" },
    { id: "three", name: "REPORT (2).txt" },
  ],
};

describe("attachment ZIP downloads", () => {
  it("preserves bytes and order while making duplicate and unsafe names safe", async () => {
    const path = await destination();
    await runCauseEffect(
      saveAttachmentArchive(
        input,
        () => Effect.succeed(path),
        (item) => Effect.sync(() => new TextEncoder().encode(item.id)),
      ),
    );
    const files = unzipSync(await readFile(path));
    expect(Object.keys(files)).toEqual(["./report.txt", "./report (2).txt", "./REPORT (2) (2).txt"]);
    expect(Object.values(files).map((bytes) => strFromU8(bytes))).toEqual(["one", "two", "three"]);
    expect(await readdir(join(path, ".."))).toEqual(["attachments.zip"]);
  });
  it("does not read any attachments when the save dialog is cancelled", async () => {
    const read = vi.fn();
    await runCauseEffect(saveAttachmentArchive(input, () => Effect.succeed(undefined), read));
    expect(read).not.toHaveBeenCalled();
  });
  it.each(["missing", "file limit", "total limit"])("keeps the destination unchanged after %s", async (failure) => {
    const path = await destination();
    await writeFile(path, "existing");
    await expect(
      runCauseEffect(
        saveAttachmentArchive(
          input,
          () => Effect.succeed(path),
          () =>
            failure === "missing"
              ? Effect.fail(new AttachmentArchiveFailed({ cause: new Error("Attachment was not found.") }))
              : Effect.succeed(
                  new Uint8Array(
                    failure === "file limit" ? ATTACHMENT_LIMITS.fileBytes + 1 : ATTACHMENT_LIMITS.fileBytes,
                  ),
                ),
        ),
      ),
    ).rejects.toThrow();
    expect(await readFile(path, "utf8")).toBe("existing");
    expect(await readdir(join(path, ".."))).toEqual(["attachments.zip"]);
  });
  it("uses a collision-safe archive name without overwriting an existing download", async () => {
    const path = await destination();
    const directory = dirname(path);
    await writeFile(path, "existing");
    await runCauseEffect(
      saveAttachmentArchive(
        input,
        () => Effect.succeed(path),
        () => Effect.succeed(new Uint8Array([1])),
      ),
    );
    expect(await readFile(path, "utf8")).toBe("existing");
    expect(Object.keys(unzipSync(await readFile(join(directory, "attachments (2).zip"))))).toEqual([
      "./report.txt",
      "./report (2).txt",
      "./REPORT (2) (2).txt",
    ]);
    expect((await readdir(directory)).sort()).toEqual(["attachments (2).zip", "attachments.zip"]);
  });
});

describe("ZIP attachment IPC", () => {
  function register(sourcePath: string) {
    const handlers = attachmentIpcHandlers({
      getMainWindow: () => null,
      translate: translateFor("en"),
      service: {
        prepareAttachments: vi.fn(),
        prepareImportedAttachments: vi.fn(),
        discardDraftAttachment: vi.fn(),
        resolveSharedFile: vi.fn(),
        resolveLocalWorkspaceFile: vi.fn(),
        listLocalWorkspaceDirectory: vi.fn(),
      },
      mailbox: {
        resolveAttachment: () => Effect.sync(() => ({ path: sourcePath, mimeType: "text/plain", name: "source.txt" })),
      },
      remoteServers: {
        supportsCapability: vi.fn(),
        request: vi.fn(),
        downloadSharedFile: vi.fn(),
        downloadWorkspaceFile: vi.fn(),
        uploadAttachment: vi.fn(),
        downloadAttachment: (id, serverId) =>
          Effect.sync(() => ({
            name: id,
            mimeType: "text/plain",
            bytes: new TextEncoder().encode(`${serverId}:${id}`),
          })),
      },
    });
    handlers.agentAttachments.downloadAttachments("download");
    const invoke = bound.get("download");
    if (!invoke) throw new Error("Download handler was not registered.");
    return invoke;
  }
  it.each(["local", "remote-host"])("downloads managed attachments from %s", async (serverId) => {
    const directory = await mkdtemp(join(tmpdir(), "attachment-downloads-"));
    directories.push(directory);
    userData.path = directory;
    const path = join(directory, "attachments.zip");
    const sourcePath = join(path, "..", "source.txt");
    await writeFile(sourcePath, "local file");
    saveDialog.mockClear();
    const invoke = register(sourcePath);
    await invoke({ senderFrame: { url: "openbot-app://app/index.html" } }, { serverId, payload: input });
    const files = unzipSync(await readFile(path));
    expect(Object.values(files).map((bytes) => strFromU8(bytes))).toEqual(
      input.attachments.map((item) => (serverId === "local" ? "local file" : `${serverId}:${item.id}`)),
    );
    expect(saveDialog).not.toHaveBeenCalled();
  });
  it("rejects an untrusted sender before opening a save dialog", async () => {
    saveDialog.mockClear();
    const invoke = register("unused");
    expect(() =>
      invoke({ senderFrame: { url: "https://example.com" } }, { serverId: "local", payload: input }),
    ).toThrow("Rejected IPC request from an untrusted renderer.");
    expect(saveDialog).not.toHaveBeenCalled();
  });
});

describe("video attachment capability", () => {
  function register(supportsVideo: boolean) {
    const uploadAttachment = vi.fn(() =>
      Effect.succeed({
        id: "uploaded-video",
        name: "clip.mp4",
        size: 1,
        kind: "file",
        mimeType: "video/mp4",
        previewKind: "none",
        previewUrl: null,
      } satisfies AttachmentSummary),
    );
    const handlers = attachmentIpcHandlers({
      getMainWindow: () => null,
      translate: translateFor("en"),
      service: {
        prepareAttachments: vi.fn(),
        prepareImportedAttachments: vi.fn(),
        discardDraftAttachment: vi.fn(),
        resolveSharedFile: vi.fn(),
        resolveLocalWorkspaceFile: vi.fn(),
        listLocalWorkspaceDirectory: vi.fn(),
      },
      mailbox: { resolveAttachment: vi.fn() },
      remoteServers: {
        supportsCapability: vi.fn(
          (_serverId, capability) => capability === TEAM_VIDEO_ATTACHMENTS_CAPABILITY && supportsVideo,
        ),
        request: vi.fn(),
        downloadSharedFile: vi.fn(),
        downloadWorkspaceFile: vi.fn(),
        uploadAttachment,
        downloadAttachment: vi.fn(),
      },
    });
    return { handlers, uploadAttachment };
  }

  it("offers MP4 in the picker only when the selected remote host supports it", async () => {
    showOpenDialog.mockClear();
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const { handlers } = register(true);
    handlers.agentAttachments.chooseAttachments("choose-video");
    const invoke = bound.get("choose-video");
    if (!invoke) throw new Error("Attachment picker handler was not registered.");
    await invoke(
      { senderFrame: { url: "openbot-app://app/index.html" } },
      { serverId: "remote-host", payload: { filter: "all" } },
    );
    expect(showOpenDialog.mock.calls[0]?.[0]).toMatchObject({
      filters: [{ extensions: expect.arrayContaining(["mp4"]) }],
    });
  });

  it("refuses to upload an MP4 to an older remote host", async () => {
    const { handlers, uploadAttachment } = register(false);
    handlers.attachmentImports.importAttachments("import-video");
    const invoke = bound.get("import-video");
    if (!invoke) throw new Error("Attachment import handler was not registered.");
    await expect(
      invoke(
        { senderFrame: { url: "openbot-app://app/index.html" } },
        { serverId: "remote-host", payload: { paths: ["/tmp/clip.mp4"], data: [] } },
      ),
    ).rejects.toThrow();
    expect(uploadAttachment).not.toHaveBeenCalled();
  });
});

describe("single attachment download", () => {
  function registerSingle(resolved: { path: string; mimeType: string; name: string }, downloadAttachment = vi.fn()) {
    const handlers = attachmentIpcHandlers({
      getMainWindow: () => null,
      translate: translateFor("en"),
      service: {
        prepareAttachments: vi.fn(),
        prepareImportedAttachments: vi.fn(),
        discardDraftAttachment: vi.fn(),
        resolveSharedFile: vi.fn(),
        resolveLocalWorkspaceFile: vi.fn(),
        listLocalWorkspaceDirectory: vi.fn(),
      },
      mailbox: { resolveAttachment: () => Effect.sync(() => resolved) },
      remoteServers: {
        supportsCapability: vi.fn(),
        request: vi.fn(),
        downloadSharedFile: vi.fn(),
        downloadWorkspaceFile: vi.fn(),
        uploadAttachment: vi.fn(),
        downloadAttachment,
      },
    });
    handlers.agentAttachments.openAttachment("single-download");
    const invoke = bound.get("single-download");
    if (!invoke) throw new Error("Open handler was not registered.");
    return invoke;
  }

  it("saves into Downloads without a dialog and preserves an existing file", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachment-single-"));
    directories.push(directory);
    userData.path = directory;
    const sourcePath = join(directory, "source-launch-brief.md");
    await writeFile(sourcePath, "brief");
    await writeFile(join(directory, "launch-brief.md"), "original");
    saveDialog.mockClear();
    const invoke = registerSingle({ path: sourcePath, mimeType: "text/markdown", name: "launch-brief.md" });
    await invoke(
      { senderFrame: { url: "openbot-app://app/index.html" } },
      { serverId: "local", payload: { attachmentId: "some-id", action: "download" } },
    );
    expect(saveDialog).not.toHaveBeenCalled();
    expect(await readFile(join(directory, "launch-brief.md"), "utf8")).toBe("original");
    expect(await readFile(join(directory, "launch-brief (2).md"), "utf8")).toBe("brief");
  });

  it("saves remote attachments directly into Downloads", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachment-remote-download-"));
    directories.push(directory);
    userData.path = directory;
    const invoke = registerSingle(
      { path: "unused", mimeType: "text/plain", name: "unused" },
      vi.fn(() => Effect.sync(() => ({ name: "report.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) }))),
    );
    await invoke(
      { senderFrame: { url: "openbot-app://app/index.html" } },
      { serverId: "remote-host", payload: { attachmentId: "some-id", action: "download" } },
    );
    expect(await readFile(join(directory, "report.pdf"))).toEqual(Buffer.from([1]));
    expect(saveDialog).not.toHaveBeenCalled();
  });

  it("keeps a remote attachment inside the cache folder when its id is a path", async () => {
    const directory = await mkdtemp(join(tmpdir(), "attachment-remote-"));
    directories.push(directory);
    userData.path = directory;
    const invoke = registerSingle(
      { path: "unused", mimeType: "text/plain", name: "unused" },
      vi.fn(() => Effect.sync(() => ({ name: "report.pdf", mimeType: "application/pdf", bytes: new Uint8Array([1]) }))),
    );
    try {
      await invoke(
        { senderFrame: { url: "openbot-app://app/index.html" } },
        { serverId: "remote-host", payload: { attachmentId: "../../escaped", action: "open" } },
      );
    } finally {
      userData.path = "";
    }
    const opened = openPath.mock.lastCall?.[0] ?? "";
    expect(dirname(opened)).toBe(join(directory, "remote-attachments"));
    expect(await readFile(opened)).toEqual(Buffer.from([1]));
    expect(await readdir(directory)).toEqual(["remote-attachments"]);
  });
});

describe("workspace file links", () => {
  function registerOpen(insideWorkspace: boolean) {
    const resolveLocalWorkspaceFile = vi.fn((_agentId: string, path: string) =>
      Effect.sync(() => ({
        path: `/resolved${path}`,
        name: "notes.md",
        size: 1,
        insideWorkspace,
      })),
    );
    const handlers = attachmentIpcHandlers({
      getMainWindow: () => null,
      translate: translateFor("en"),
      service: {
        prepareAttachments: vi.fn(),
        prepareImportedAttachments: vi.fn(),
        discardDraftAttachment: vi.fn(),
        resolveSharedFile: vi.fn(),
        resolveLocalWorkspaceFile,
        listLocalWorkspaceDirectory: vi.fn(),
      },
      mailbox: { resolveAttachment: vi.fn() },
      remoteServers: {
        supportsCapability: vi.fn(),
        request: vi.fn(),
        downloadSharedFile: vi.fn(),
        downloadWorkspaceFile: vi.fn(),
        uploadAttachment: vi.fn(),
        downloadAttachment: vi.fn(),
      },
    });
    handlers.agentAttachments.openWorkspaceFile("open-workspace-file");
    const invoke = bound.get("open-workspace-file");
    if (!invoke) throw new Error("Open workspace file handler was not registered.");
    return invoke;
  }

  it.each([
    { insideWorkspace: true, called: openPath, notCalled: showItemInFolder },
    { insideWorkspace: false, called: showItemInFolder, notCalled: openPath },
  ])("runs only a workspace file; insideWorkspace=$insideWorkspace", async ({ insideWorkspace, called, notCalled }) => {
    openPath.mockClear();
    showItemInFolder.mockClear();
    const invoke = registerOpen(insideWorkspace);
    await invoke(
      { senderFrame: { url: "openbot-app://app/index.html" } },
      { serverId: "local", payload: { agentId: "agent-1", path: "/Users/me/project/run.sh" } },
    );
    expect(called).toHaveBeenCalledExactlyOnceWith("/resolved/Users/me/project/run.sh");
    expect(notCalled).not.toHaveBeenCalled();
  });
});
