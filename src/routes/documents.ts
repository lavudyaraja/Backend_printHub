// User document upload. Files are stored in Neon (Document.fileData) as a
// temporary buffer — no external object storage. A cleanup sweep removes
// documents that were never turned into a paid order.
import { Router } from "express";
import multer from "multer";
import { PDFDocument } from "pdf-lib";
import { prisma } from "../lib/prisma";
import { config } from "../lib/config";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";

export const documentsRouter = Router();

const upload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: config.maxUploadBytes },
});

function detectType(mime: string, name: string): "pdf" | "image" | "docx" | "pptx" | "other" {
  const m = (mime || "").toLowerCase();
  const n = (name || "").toLowerCase();
  if (m === "application/pdf" || n.endsWith(".pdf")) return "pdf";
  if (m.startsWith("image/") || /\.(png|jpe?g|gif|webp|heic)$/.test(n)) return "image";
  if (m.includes("wordprocessingml") || n.endsWith(".docx")) return "docx";
  if (m.includes("presentationml") || n.endsWith(".pptx")) return "pptx";
  return "other";
}

async function countPdfPages(buf: Buffer): Promise<number> {
  try {
    const pdf = await PDFDocument.load(buf, { ignoreEncryption: true, updateMetadata: false });
    return Math.max(1, pdf.getPageCount());
  } catch {
    return 1;
  }
}

// ── Upload a document ───────────────────────────────────────────────────────
documentsRouter.post("/upload", requireAuth, upload.single("file"), async (req: AuthedRequest, res) => {
  const file = req.file;
  if (!file) return res.status(400).json({ error: "No file uploaded." });

  const fileType = detectType(file.mimetype, file.originalname);
  const pageCount = fileType === "pdf" ? await countPdfPages(file.buffer) : 1;

  const doc = await prisma.document.create({
    data: {
      userId: req.user!.userId,
      fileName: file.originalname || `upload.${fileType}`,
      fileType,
      fileKey: `neon/${req.user!.userId}`,
      mimeType: file.mimetype || "application/octet-stream",
      fileData: file.buffer,
      sizeBytes: file.size,
      pageCount,
    },
    select: { id: true, fileName: true, fileType: true, pageCount: true },
  });

  res.json({ tempKey: doc.id, fileName: doc.fileName, fileType: doc.fileType, pageCount: doc.pageCount });
});

// ── Serve the raw file (used for previews) ──────────────────────────────────
// No Authorization header (RN <Image> can't send one) — the cuid id is the
// unguessable secret. Only non-deleted files are served.
documentsRouter.get("/file/:id", async (req, res) => {
  const doc = await prisma.document.findUnique({
    where: { id: req.params.id },
    select: { fileData: true, mimeType: true, deleted: true },
  });
  if (!doc || doc.deleted || !doc.fileData) return res.status(404).json({ error: "Not found" });
  res.setHeader("Content-Type", doc.mimeType || "application/octet-stream");
  res.setHeader("Cache-Control", "private, max-age=600");
  res.send(Buffer.from(doc.fileData));
});

// Alias so the mobile "temp" preview path resolves for images.
documentsRouter.get("/preview/temp/:id", (req, res) => {
  res.redirect(`/api/documents/file/${req.params.id}`);
});
