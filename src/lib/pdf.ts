// PDF → PNG page rendering via MuPDF WebAssembly. Pure WASM — no python, no
// node-canvas, no system libraries — so it runs on any host (Render native
// runtime included) with a plain `npm install`. mupdf is ESM-only, hence the
// dynamic import from this CommonJS build.

let _mupdf: any;
async function getMupdf() {
  if (!_mupdf) _mupdf = await import("mupdf");
  return _mupdf;
}

// Render a single 1-indexed PDF page to a PNG buffer.
export async function renderPdfPageToPng(
  pdfBuffer: Buffer,
  pageNumber: number,
  scale = 2
): Promise<Buffer> {
  const mupdf = await getMupdf();
  const doc = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
  const count = doc.countPages();
  if (pageNumber < 1 || pageNumber > count) {
    throw new Error(`page ${pageNumber} out of range (1-${count})`);
  }
  const page = doc.loadPage(pageNumber - 1); // MuPDF is 0-indexed
  const pixmap = page.toPixmap(
    mupdf.Matrix.scale(scale, scale),
    mupdf.ColorSpace.DeviceRGB,
    false, // no alpha — white background for print previews
    true
  );
  return Buffer.from(pixmap.asPNG());
}

// Render ALL (or first `maxPages`) pages in one document-open pass.
// Returns PNG buffers indexed from 0 (page 1 = index 0).
// maxPages: cap how many pages to render (undefined = all).
export async function renderAllPdfPagesToPng(
  pdfBuffer: Buffer,
  scale = 1.2,
  maxPages?: number
): Promise<Buffer[]> {
  const mupdf = await getMupdf();
  const doc   = mupdf.Document.openDocument(pdfBuffer, "application/pdf");
  const count = doc.countPages();
  const limit = maxPages !== undefined ? Math.min(count, maxPages) : count;
  const results: Buffer[] = [];
  for (let i = 0; i < limit; i++) {
    const page   = doc.loadPage(i);
    const pixmap = page.toPixmap(
      mupdf.Matrix.scale(scale, scale),
      mupdf.ColorSpace.DeviceRGB,
      false // white background (good for print preview)
    );
    results.push(Buffer.from(pixmap.asPNG()));
  }
  return results;
}
