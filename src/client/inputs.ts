import { createHash } from "node:crypto";
import { constants } from "node:fs";
import { open } from "node:fs/promises";
import { Keypair, PublicKey } from "@solana/web3.js";

export function hashBytes(value: string | Uint8Array): Buffer {
  return createHash("sha256").update(value).digest();
}

export function hashHex(value: string | Uint8Array): string {
  return hashBytes(value).toString("hex");
}

export function requireHash(value: Uint8Array): Buffer {
  if (value.length !== 32 || value.every((byte) => byte === 0)) {
    throw new Error("A hash must contain 32 bytes and cannot be all zero.");
  }
  return Buffer.from(value);
}

export function parseHash(value: string): Buffer {
  if (!/^[0-9a-fA-F]{64}$/.test(value)) {
    throw new Error("A hash must be exactly 64 hexadecimal characters.");
  }
  return requireHash(Buffer.from(value, "hex"));
}

export function validatePublicKey(value: string, label = "Address"): PublicKey {
  try {
    return new PublicKey(value);
  } catch {
    throw new Error(`${label} must be a valid Solana public key.`);
  }
}

export async function readKeypair(path: string): Promise<Keypair> {
  const invalid = () =>
    new Error(
      "Keypair file must contain a valid JSON array of 64 secret-key bytes (maximum 4 KiB).",
    );
  const file = await open(
    path,
    constants.O_RDONLY | constants.O_NONBLOCK,
  ).catch(() => {
    throw invalid();
  });
  try {
    const info = await file.stat();
    if (!info.isFile() || info.size > 4096) throw invalid();
    const buffer = Buffer.alloc(4097);
    const { bytesRead } = await file.read(buffer, 0, buffer.length, 0);
    if (bytesRead > 4096) throw invalid();
    const bytes: unknown = JSON.parse(
      buffer.subarray(0, bytesRead).toString("utf8"),
    );
    if (
      !Array.isArray(bytes) ||
      bytes.length !== 64 ||
      !bytes.every(
        (byte: unknown) =>
          typeof byte === "number" &&
          Number.isInteger(byte) &&
          byte >= 0 &&
          byte <= 255,
      )
    ) {
      throw invalid();
    }
    return Keypair.fromSecretKey(Uint8Array.from(bytes as number[]));
  } catch {
    throw invalid();
  } finally {
    await file.close();
  }
}

/** Hash exact file bytes locally. Never place the file contents on-chain. */
export async function hashFile(path: string): Promise<Buffer> {
  const file = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  try {
    const info = await file.stat();
    const maximumBytes = 64 * 1024 * 1024;
    if (!info.isFile() || info.size > maximumBytes) {
      throw new Error(
        "Hash input must be a regular file no larger than 64 MiB.",
      );
    }
    const digest = createHash("sha256");
    let total = 0;
    for await (const chunk of file.createReadStream({ autoClose: false })) {
      total += chunk.length;
      if (total > maximumBytes) throw new Error("Hash input exceeds 64 MiB.");
      digest.update(chunk);
    }
    return digest.digest();
  } finally {
    await file.close();
  }
}
