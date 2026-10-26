import { createPrivateKey, createPublicKey, X509Certificate } from "node:crypto";
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ensureSunshineCertificate } from "./sunshine-certificate";

const directories: string[] = [];

afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});

async function createDirectory(): Promise<string> {
  const directory = await mkdtemp(join(tmpdir(), "openbot-sunshine-cert-"));
  directories.push(directory);
  return directory;
}

async function readPair(directory: string): Promise<{ privateKey: string; certificate: string }> {
  const [privateKey, certificate] = await Promise.all([
    readFile(join(directory, "sunshine-key.pem"), "utf8"),
    readFile(join(directory, "sunshine-cert.pem"), "utf8"),
  ]);
  return { privateKey, certificate };
}

describe("ensureSunshineCertificate", () => {
  it("creates a private local server certificate and reuses the same identity", async () => {
    const directory = await createDirectory();

    await ensureSunshineCertificate(directory);
    const first = await readPair(directory);
    const certificate = new X509Certificate(first.certificate);
    const privatePublicKey = createPublicKey(createPrivateKey(first.privateKey)).export({
      type: "spki",
      format: "der",
    });
    const certificatePublicKey = certificate.publicKey.export({ type: "spki", format: "der" });
    const permissions = (await stat(join(directory, "sunshine-key.pem"))).mode & 0o777;

    expect(privatePublicKey.equals(certificatePublicKey)).toBe(true);
    expect(certificate.checkHost("localhost")).toBeTruthy();
    expect(certificate.checkIP("127.0.0.1")).toBeTruthy();
    expect(Date.parse(certificate.validTo)).toBeGreaterThan(Date.now());
    expect(permissions).toBe(0o600);

    await ensureSunshineCertificate(directory);
    expect(await readPair(directory)).toEqual(first);
  });

  it("rebuilds an interrupted certificate from the existing private key", async () => {
    const directory = await createDirectory();
    await ensureSunshineCertificate(directory);
    const original = await readPair(directory);
    await rm(join(directory, "sunshine-cert.pem"));

    await ensureSunshineCertificate(directory);

    const recovered = await readPair(directory);
    expect(recovered.privateKey).toBe(original.privateKey);
    expect(new X509Certificate(recovered.certificate).checkHost("localhost")).toBeTruthy();
  });

  it("preserves an orphan certificate and reports the missing private key", async () => {
    const directory = await createDirectory();
    await ensureSunshineCertificate(directory);
    const original = await readFile(join(directory, "sunshine-cert.pem"), "utf8");
    await rm(join(directory, "sunshine-key.pem"));

    await expect(ensureSunshineCertificate(directory)).rejects.toThrow("private key is missing");
    expect(await readFile(join(directory, "sunshine-cert.pem"), "utf8")).toBe(original);
    await expect(readFile(join(directory, "sunshine-key.pem"))).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("refuses a mismatched key and certificate without replacing either", async () => {
    const firstDirectory = await createDirectory();
    const secondDirectory = await createDirectory();
    await Promise.all([ensureSunshineCertificate(firstDirectory), ensureSunshineCertificate(secondDirectory)]);
    const first = await readPair(firstDirectory);
    const second = await readPair(secondDirectory);
    await writeFile(join(firstDirectory, "sunshine-key.pem"), second.privateKey);

    await expect(ensureSunshineCertificate(firstDirectory)).rejects.toThrow("does not match");
    expect(await readFile(join(firstDirectory, "sunshine-key.pem"), "utf8")).toBe(second.privateKey);
    expect(await readFile(join(firstDirectory, "sunshine-cert.pem"), "utf8")).toBe(first.certificate);
  });
});
