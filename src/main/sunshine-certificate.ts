import {
  createPrivateKey,
  createPublicKey,
  generateKeyPair,
  randomBytes,
  timingSafeEqual,
  X509Certificate,
} from "node:crypto";
import { chmod, mkdir, readFile, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import forge from "node-forge";

const PRIVATE_KEY_NAME = "sunshine-key.pem";
const CERTIFICATE_NAME = "sunshine-cert.pem";
const CERTIFICATE_VALIDITY_YEARS = 10;

interface GeneratedPemKeyPair {
  publicKey: string;
  privateKey: string;
}

/**
 * Keeps Sunshine's host identity under the OpenBot state directory. Existing valid key pairs are
 * reused; an interrupted first write can recover its certificate from the already-written key.
 */
export async function ensureSunshineCertificate(stateDirectory: string): Promise<void> {
  await mkdir(stateDirectory, { recursive: true, mode: 0o700 });
  const privateKeyPath = join(stateDirectory, PRIVATE_KEY_NAME);
  const certificatePath = join(stateDirectory, CERTIFICATE_NAME);
  const [privateKeyPem, certificatePem] = await Promise.all([
    readOptional(privateKeyPath),
    readOptional(certificatePath),
  ]);

  if (privateKeyPem && certificatePem) {
    await validatePair(privateKeyPem, certificatePem);
    await chmod(privateKeyPath, 0o600);
    return;
  }

  if (!privateKeyPem && certificatePem) {
    throw new Error(
      "Sunshine's private key is missing while its certificate exists; the existing host identity was preserved.",
    );
  }

  const keyPair = privateKeyPem ? null : await generatePemKeyPair();
  const privatePem = privateKeyPem ?? keyPair?.privateKey;
  const publicPem = keyPair?.publicKey;
  if (!privatePem) throw new Error("Sunshine's private key could not be created.");

  const certificate = createCertificate(privatePem, publicPem);
  const certificateData = forge.pki.certificateToPem(certificate);
  const privateTemp = privateKeyPem
    ? null
    : join(stateDirectory, `.sunshine-key-${randomBytes(8).toString("hex")}.tmp`);
  const certificateTemp = join(stateDirectory, `.sunshine-cert-${randomBytes(8).toString("hex")}.tmp`);

  try {
    if (privateTemp) await writeFile(privateTemp, privatePem, { mode: 0o600, flag: "wx" });
    await writeFile(certificateTemp, certificateData, { mode: 0o600, flag: "wx" });
    if (privateTemp) await rename(privateTemp, privateKeyPath);
    await rename(certificateTemp, certificatePath);
    await chmod(privateKeyPath, 0o600);
  } catch (error) {
    if (privateTemp) await rm(privateTemp, { force: true }).catch(() => undefined);
    await rm(certificateTemp, { force: true }).catch(() => undefined);
    throw error;
  }

  await validatePair(privatePem, certificateData);
}

async function readOptional(path: string): Promise<string | null> {
  try {
    return await readFile(path, "utf8");
  } catch (error) {
    if (error && typeof error === "object" && "code" in error && error.code === "ENOENT") return null;
    throw error;
  }
}

function generatePemKeyPair(): Promise<GeneratedPemKeyPair> {
  return new Promise((resolve, reject) => {
    generateKeyPair(
      "rsa",
      {
        modulusLength: 2048,
        publicKeyEncoding: { type: "spki", format: "pem" },
        privateKeyEncoding: { type: "pkcs1", format: "pem" },
      },
      (error, publicKey, privateKey) => {
        if (error) reject(error);
        else resolve({ publicKey: String(publicKey), privateKey: String(privateKey) });
      },
    );
  });
}

function createCertificate(privateKeyPem: string, publicKeyPem?: string): forge.pki.Certificate {
  const privateKey = forge.pki.privateKeyFromPem(privateKeyPem);
  const publicKey = publicKeyPem
    ? forge.pki.publicKeyFromPem(publicKeyPem)
    : forge.pki.setRsaPublicKey(privateKey.n, privateKey.e);
  const certificate = forge.pki.createCertificate();
  const subject = [{ name: "commonName", value: "OpenBot Remote Desktop" }];
  certificate.publicKey = publicKey;
  certificate.serialNumber = randomBytes(16).toString("hex").replace(/^0+/, "") || "01";
  certificate.validity.notBefore = new Date(Date.now() - 60_000);
  certificate.validity.notAfter = new Date(Date.now() + CERTIFICATE_VALIDITY_YEARS * 365 * 24 * 60 * 60 * 1_000);
  certificate.setSubject(subject);
  certificate.setIssuer(subject);
  certificate.setExtensions([
    { name: "basicConstraints", cA: false },
    { name: "keyUsage", digitalSignature: true, keyEncipherment: true },
    { name: "extKeyUsage", serverAuth: true },
    {
      name: "subjectAltName",
      altNames: [
        { type: 2, value: "localhost" },
        { type: 7, ip: "127.0.0.1" },
      ],
    },
  ]);
  certificate.sign(privateKey, forge.md.sha256.create());
  return certificate;
}

async function validatePair(privateKeyPem: string, certificatePem: string): Promise<void> {
  const privateKey = createPrivateKey(privateKeyPem);
  if (privateKey.asymmetricKeyType !== "rsa") throw new Error("Sunshine's private key is not an RSA key.");
  const certificate = new X509Certificate(certificatePem);
  const privatePublic = createPublicKey(privateKey).export({ type: "spki", format: "der" });
  const certificatePublic = certificate.publicKey.export({ type: "spki", format: "der" });
  if (privatePublic.byteLength !== certificatePublic.byteLength || !timingSafeEqual(privatePublic, certificatePublic)) {
    throw new Error("Sunshine's certificate does not match its private key; the existing host identity was preserved.");
  }
  if (Date.parse(certificate.validTo) <= Date.now()) {
    throw new Error("Sunshine's certificate has expired; the existing host identity was preserved.");
  }
}
