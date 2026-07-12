// Neon Database-backed storage helper.
// Replaces Backblaze B2 and local filesystem storage.
// Files and cached preview pages are stored directly in PostgreSQL under the StorageObject table.
import { prisma } from "./prisma";

export function storageConfigured() {
  return true; // Database storage is always available
}

export async function putObject(key: string, body: Buffer, contentType?: string) {
  try {
    await prisma.storageObject.upsert({
      where: { key },
      create: { key, body, mimeType: contentType },
      update: { body, mimeType: contentType },
    });
  } catch (e) {
    console.error(`[storage] Database write failed for ${key}:`, e);
    throw e;
  }
}

export async function getObjectBuffer(key: string): Promise<Buffer | null> {
  try {
    const obj = await prisma.storageObject.findUnique({
      where: { key },
    });
    return obj ? obj.body : null;
  } catch (e) {
    console.error(`[storage] Database read failed for ${key}:`, e);
    return null;
  }
}

// Return backend download URL directly
export async function presignGet(key: string, expiresSeconds = 600): Promise<string> {
  const backendUrl = process.env.BACKEND_URL || "http://localhost:4000";
  return `${backendUrl}/api/kiosk/download/${key}`;
}

export async function deleteKeys(keys: string[]) {
  if (!keys.length) return;
  try {
    await prisma.storageObject.deleteMany({
      where: { key: { in: keys } },
    });
  } catch (e) {
    console.error("[storage] Database delete failed:", e);
  }
}

export async function deleteFileAndPreviews(fileKey: string) {
  const previewKeys = await listKeys(`${fileKey}_page_`);
  await deleteKeys([fileKey, ...previewKeys]);
}

async function listKeys(prefix: string): Promise<string[]> {
  try {
    const objs = await prisma.storageObject.findMany({
      where: { key: { startsWith: prefix } },
      select: { key: true },
    });
    return objs.map((o) => o.key);
  } catch (e) {
    console.error("[storage] Database list keys failed:", e);
    return [];
  }
}
