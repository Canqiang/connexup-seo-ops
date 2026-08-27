import { constants } from "node:fs";
import fs from "node:fs/promises";
import path from "node:path";

const MAX_SECRET_BYTES = 4_096;
const SECRET_REF_PATTERN = /^[a-z][a-z0-9]*(?:-[a-z0-9]+)*$/;

/** Deliberately carries no path, ref, token, fs cause, or platform detail. */
export class GbpCredentialError extends Error {
  constructor() {
    super("GBP credential unavailable");
    this.name = "GbpCredentialError";
  }
}

/**
 * Resolve one mounted Core API credential by logical basename. The value stays
 * in memory only; all failure branches collapse to the same redacted error.
 */
export async function resolveGbpCredential(secretDir: string, secretRef: string): Promise<string> {
  let handle: fs.FileHandle | null = null;
  try {
    if (!SECRET_REF_PATTERN.test(secretRef)
      || path.basename(secretRef) !== secretRef
      || secretRef === "."
      || secretRef === "..") {
      throw new GbpCredentialError();
    }

    const root = await fs.realpath(secretDir);
    const rootStat = await fs.lstat(root);
    if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) throw new GbpCredentialError();
    const candidate = path.join(root, secretRef);
    if (path.dirname(candidate) !== root) throw new GbpCredentialError();

    const beforeOpen = await fs.lstat(candidate);
    if (!beforeOpen.isFile() || beforeOpen.isSymbolicLink()) throw new GbpCredentialError();
    handle = await fs.open(candidate, constants.O_RDONLY | constants.O_NOFOLLOW);
    const opened = await handle.stat();
    if (!opened.isFile() || opened.size < 1 || opened.size > MAX_SECRET_BYTES
      || (opened.mode & 0o077) !== 0
      || opened.dev !== beforeOpen.dev || opened.ino !== beforeOpen.ino) {
      throw new GbpCredentialError();
    }

    const bytes = await handle.readFile();
    if (bytes.byteLength < 1 || bytes.byteLength > MAX_SECRET_BYTES) throw new GbpCredentialError();
    const value = bytes.toString("utf8").replace(/\r?\n$/, "");
    if (value.length === 0 || /[\s\u0000-\u001f\u007f]/.test(value)) throw new GbpCredentialError();
    return value;
  } catch {
    throw new GbpCredentialError();
  } finally {
    await handle?.close().catch(() => undefined);
  }
}
