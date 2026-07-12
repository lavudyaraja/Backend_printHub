/**
 * Document upload — TEMP-FIRST architecture.
 *
 * New flow:
 *   POST /upload   → store file in memory Map (15-min TTL), return tempKey + metadata
 *   GET  /preview/temp/:tempKey/:page → render PDF page from memory (on-demand, fast)
 *   GET  /docx-preview/temp/:tempKey  → convert DOCX → HTML from memory
 *   POST /commit   → called from order creation: upload to B2, create Document record
 *
 * B2 is NOT written during /upload — only when the user confirms their order.
 * If user abandons the configure screen, nothing is persisted.
 */
import { Router } from "express";
import multer from "multer";
import { nanoid } from "nanoid";
import pdfParse from "pdf-parse";
import mammoth from "mammoth";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { renderPdfPageToPng } from "../lib/pdf";
import { putObject, getObjectBuffer } from "../lib/storage";

export const documentsRouter = Router();

// ── In-memory temp buffer store ───────────────────────────────────────────────
interface TempEntry {
  buffer: Buffer;
  mimeType: string;
  fileName: string;
  fileType: string; // "pdf" | "docx" | "image"
  pageCount: number;
  expiresAt: number; // epoch ms
}

const TEMP_TTL_MS = 15 * 60 * 1000; // 15 minutes
const tempBuffers = new Map<string, TempEntry>();

// Background cleanup of expired entries
setInterval(() => {
  const now = Date.now();
  for (const [key, entry] of tempBuffers) {
    if (entry.expiresAt < now) {
      tempBuffers.delete(key);
      console.log(`[temp] expired: ${key}`);
    }
  }
}, 60_000);

// ── Multer (50 MB limit, memory only for temp phase) ──────────────────────────
const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: 50 * 1024 * 1024 }, // 50 MB
});

const ALLOWED: Record<string, string> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "image/png": "image",
  "image/jpeg": "image",
};

// ── POST /upload — store in memory, return tempKey immediately ────────────────
// No B2 write here. No thumbnail rendering. Returns in < 1 second.
documentsRouter.post(
  "/upload",
  requireAuth,
  upload.single("file"),
  async (req: AuthedRequest, res) => {
    const file = req.file;
    if (!file) return res.status(400).json({ error: "No file" });
    const fileType = ALLOWED[file.mimetype];
    if (!fileType) return res.status(400).json({ error: "Unsupported file type" });

    // Parse page count for PDFs (fast — just reads the PDF metadata, no rendering)
    let pageCount = 1;
    if (fileType === "pdf") {
      try { pageCount = (await pdfParse(file.buffer)).numpages || 1; }
      catch { pageCount = 1; }
    }

    // Store in memory with TTL
    const tempKey = nanoid(20);
    tempBuffers.set(tempKey, {
      buffer: file.buffer,
      mimeType: file.mimetype,
      fileName: file.originalname,
      fileType,
      pageCount,
      expiresAt: Date.now() + TEMP_TTL_MS,
    });

    console.log(`[upload] buffered ${file.originalname} (${fileType}, ${pageCount}p) → ${tempKey}`);

    res.json({
      tempKey,
      fileName: file.originalname,
      fileType,
      pageCount,
      sizeBytes: file.size,
    });
  }
);

// ── GET /preview/temp/:tempKey/:page — render PDF page from memory ────────────
// Returns PNG. Renders on-demand (no caching needed since buffer is in-memory).
documentsRouter.get("/preview/temp/:tempKey/:page", async (req, res) => {
  const { tempKey, page } = req.params;
  const entry = tempBuffers.get(tempKey);
  if (!entry) return res.status(404).json({ error: "Temp file expired or not found — please re-upload" });

  // Refresh TTL on access
  entry.expiresAt = Date.now() + TEMP_TTL_MS;

  // Images: serve buffer directly
  if (entry.fileType === "image") {
    return res.type(entry.mimeType).send(entry.buffer);
  }

  if (entry.fileType !== "pdf") {
    return res.status(400).json({ error: "Preview only available for PDF and images" });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const scale = Math.min(2, Math.max(0.5, parseFloat((req.query.scale as string) || "1.2")));

  try {
    const png = await renderPdfPageToPng(entry.buffer, pageNum, scale);
    res.type("image/png").set("Cache-Control", "no-store").send(png);
  } catch (err) {
    console.error("[preview/temp] render failed", err);
    res.status(404).json({ error: "Page not found" });
  }
});

// ── GET /docx-preview/temp/:tempKey — DOCX → HTML from memory ────────────────
documentsRouter.get("/docx-preview/temp/:tempKey", async (req, res) => {
  const { tempKey } = req.params;
  const entry = tempBuffers.get(tempKey);
  if (!entry) return res.status(404).json({ error: "Temp file expired — please re-upload" });

  entry.expiresAt = Date.now() + TEMP_TTL_MS;

  if (entry.fileType !== "docx") {
    return res.status(400).json({ error: "Not a DOCX file" });
  }

  try {
    const { value: bodyHtml } = await mammoth.convertToHtml({ buffer: entry.buffer });
    const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=2">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.7;
         color: #1a1a1a; background: #fff; padding: 18px; }
  h1,h2,h3,h4,h5,h6 { font-weight: 700; margin: 18px 0 8px; line-height: 1.3; }
  h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
  p { margin-bottom: 10px; }
  ul,ol { padding-left: 22px; margin-bottom: 10px; }
  li { margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 14px; font-size: 13px; }
  th,td { border: 1px solid #dde1e7; padding: 7px 10px; text-align: left; }
  th { background: #f5f6fa; font-weight: 700; }
  img { max-width: 100%; height: auto; border-radius: 4px; margin: 8px 0; }
  strong,b { font-weight: 700; } em,i { font-style: italic; } u { text-decoration: underline; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
    res.type("text/html").send(page);
  } catch (e) {
    console.error("[docx-preview/temp] failed", e);
    res.status(500).json({ error: "DOCX conversion failed" });
  }
});

// ── POST /commit — upload temp file to B2 and create Document record ──────────
// Called from the order creation flow (orders.ts "from-temp" endpoint).
// Returns the created Document. Removes from tempBuffers after commit.
export async function commitTempFile(
  tempKey: string,
  userId: string
): Promise<{ id: string; fileKey: string; fileType: string; pageCount: number; fileName: string }> {
  const entry = tempBuffers.get(tempKey);
  if (!entry) throw new Error("TEMP_EXPIRED");

  const ext = entry.fileName.split(".").pop() || "bin";
  const fileKey = `${nanoid()}.${ext}`;

  // Upload original file to B2
  await putObject(fileKey, entry.buffer, entry.mimeType);

  // Create DB record
  const doc = await prisma.document.create({
    data: {
      userId,
      fileName: entry.fileName,
      fileType: entry.fileType,
      fileKey,
      sizeBytes: entry.buffer.length,
      pageCount: entry.pageCount,
    },
  });

  // Remove from temp store — B2 is now the source of truth
  tempBuffers.delete(tempKey);
  console.log(`[commit] ${entry.fileName} → B2:${fileKey}, doc:${doc.id}`);

  return doc;
}

// ── GET /preview/:fileKey/:page — serve committed PDF pages from B2 ───────────
// Used by IoT and order tracking screens after commit.
documentsRouter.get("/preview/:fileKey/:page", requireAuth, async (req: AuthedRequest, res) => {
  const { fileKey, page } = req.params;
  const doc = await prisma.document.findFirst({ where: { fileKey, deleted: false } });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  // Security: verify that the user owns the document or is an admin
  if (doc.userId !== req.user!.userId && req.user!.role !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden: You do not own this document" });
  }

  if (doc.fileType === "image") {
    const buf = await getObjectBuffer(fileKey);
    if (!buf) return res.status(404).json({ error: "File not found" });
    const mime = doc.fileName.toLowerCase().endsWith(".png") ? "image/png" : "image/jpeg";
    return res.type(mime).send(buf);
  }

  if (doc.fileType !== "pdf") {
    return res.status(400).json({ error: "Preview not supported for this file type" });
  }

  const pageNum = Math.max(1, parseInt(page, 10) || 1);
  const scale = Math.min(2, Math.max(0.5, parseFloat((req.query.scale as string) || "1.2")));
  const cacheKey = `${fileKey}_page_${pageNum}_s${scale.toFixed(1)}.png`;

  let preview = await getObjectBuffer(cacheKey);
  if (!preview) {
    const pdfBuf = await getObjectBuffer(fileKey);
    if (!pdfBuf) return res.status(404).json({ error: "File not found" });
    try {
      preview = await renderPdfPageToPng(pdfBuf, pageNum, scale);
      putObject(cacheKey, preview, "image/png").catch(() => { });
    } catch {
      return res.status(404).json({ error: "Preview page not found" });
    }
  }

  res.type("image/png").set("Cache-Control", "public, max-age=3600").send(preview);
});

// ── GET /docx-preview/:fileKey — DOCX → HTML from B2 ─────────────────────────
documentsRouter.get("/docx-preview/:fileKey", requireAuth, async (req: AuthedRequest, res) => {
  const { fileKey } = req.params;
  const doc = await prisma.document.findFirst({ where: { fileKey, deleted: false } });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  // Security: verify that the user owns the document or is an admin
  if (doc.userId !== req.user!.userId && req.user!.role !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden: You do not own this document" });
  }

  if (doc.fileType !== "docx") {
    return res.status(400).json({ error: "Not a DOCX file" });
  }

  try {
    const buf = await getObjectBuffer(fileKey);
    if (!buf) return res.status(404).json({ error: "File not found" });

    const { value: bodyHtml } = await mammoth.convertToHtml({ buffer: buf });
    const page = `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1, maximum-scale=2">
<style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: 'Segoe UI', Arial, sans-serif; font-size: 14px; line-height: 1.7;
         color: #1a1a1a; background: #fff; padding: 18px; }
  h1,h2,h3,h4,h5,h6 { font-weight: 700; margin: 18px 0 8px; line-height: 1.3; }
  h1 { font-size: 20px; } h2 { font-size: 17px; } h3 { font-size: 15px; }
  p { margin-bottom: 10px; }
  ul,ol { padding-left: 22px; margin-bottom: 10px; }
  li { margin-bottom: 4px; }
  table { border-collapse: collapse; width: 100%; margin-bottom: 14px; font-size: 13px; }
  th,td { border: 1px solid #dde1e7; padding: 7px 10px; text-align: left; }
  th { background: #f5f6fa; font-weight: 700; }
  img { max-width: 100%; height: auto; border-radius: 4px; margin: 8px 0; }
  strong,b { font-weight: 700; } em,i { font-style: italic; } u { text-decoration: underline; }
</style>
</head>
<body>${bodyHtml}</body>
</html>`;
    res.type("text/html").send(page);
  } catch (e) {
    console.error("[docx-preview] failed", e);
    res.status(500).json({ error: "DOCX conversion failed" });
  }
});

// ── GET /file/:fileKey — download committed file ──────────────────────────────
documentsRouter.get("/file/:fileKey", requireAuth, async (req: AuthedRequest, res) => {
  const { fileKey } = req.params;
  const doc = await prisma.document.findFirst({ where: { fileKey, deleted: false } });
  if (!doc) return res.status(404).json({ error: "Document not found" });

  // Security: verify that the user owns the document or is an admin
  if (doc.userId !== req.user!.userId && req.user!.role !== "ADMIN") {
    return res.status(403).json({ error: "Forbidden: You do not own this document" });
  }

  const buf = await getObjectBuffer(fileKey);
  if (!buf) return res.status(404).json({ error: "File not found" });
  res.send(buf);
});

// ── GET / — list user's committed documents ───────────────────────────────────
documentsRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const docs = await prisma.document.findMany({
    where: { userId: req.user!.userId, deleted: false },
    orderBy: { createdAt: "desc" },
  });
  res.json({ documents: docs });
});
