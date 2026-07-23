// Render a PDF's pages to raster bitmaps, so a PDF can be printed on a cheap
// laser (Pantum, etc.) that has no PDF interpreter and only accepts PWG-Raster /
// URF. Uses PDFium compiled to WebAssembly — no native binaries, no system
// packages — so it runs unchanged on the deploy host.
//
// Each page comes back as a Jimp image at ~300 dpi, ready to be laid onto the A4
// raster canvas the printer expects (see pwgRaster.ts / urf.ts).
import Jimp from "jimp";

/** 72 pt/inch → 300 dpi. Matches the raster canvas the encoders target. */
const RENDER_SCALE = 300 / 72;

// @hyzyla/pdfium ships as ESM only; this backend compiles to CommonJS, so it is
// pulled in with a dynamic import (the one interop path TypeScript won't rewrite
// into a broken `require`). Cached after the first load.
let pdfiumModule: Promise<any> | null = null;
function loadPdfium(): Promise<any> {
  if (!pdfiumModule) pdfiumModule = import("@hyzyla/pdfium");
  return pdfiumModule;
}

// A hard cap so a huge PDF can't exhaust memory on a small instance. At 300 dpi
// one A4 page is ≈35 MB and at 600 dpi ≈140 MB, so even one at a time this many
// is the ceiling a 512 MB box can process without risking an OOM kill.
const MAX_PAGES = 40;

/** Render one PDFium page to a Jimp image (BGRA→RGBA corrected), or null on failure. */
async function renderOne(page: any): Promise<Jimp | null> {
  try {
    const rendered = await page.render({ scale: RENDER_SCALE, render: "bitmap" });
    const data = Buffer.from(rendered.data);
    // PDFium hands back BGRA; Jimp reads RGBA — swap the red/blue channels so
    // colours (and the luminance the encoders derive) come out right.
    for (let i = 0; i + 2 < data.length; i += 4) {
      const b = data[i];
      data[i] = data[i + 2];
      data[i + 2] = b;
    }
    return await new Promise<Jimp>((resolve, reject) =>
      new Jimp({ data, width: rendered.width, height: rendered.height }, (err: Error | null, img: Jimp) =>
        err ? reject(err) : resolve(img)
      )
    );
  } catch (e) {
    console.error("[pdfRender] page render failed, skipping:", e);
    return null;
  }
}

/**
 * Render a PDF page by page, handing each Jimp image to `onPage` and then
 * dropping the reference before rendering the next. This is the memory-safe way
 * to rasterise a multi-page PDF on a small instance: peak memory stays at a
 * single page's bitmap instead of the whole document's. The encoders (PWG, URF)
 * consume each page straight into their output stream, so a page is freed as
 * soon as it's encoded. Returns the number of pages actually rendered.
 */
export async function forEachPdfPage(pdf: Buffer, onPage: (img: Jimp, index: number) => void): Promise<number> {
  const { PDFiumLibrary } = await loadPdfium();
  const library = await PDFiumLibrary.init();
  try {
    const doc = await library.loadDocument(pdf);
    try {
      let count = 0;
      for (const page of doc.pages()) {
        if (count >= MAX_PAGES) break;
        const img = await renderOne(page);
        if (img) onPage(img, count);
        count++;
      }
      return count;
    } finally {
      doc.destroy();
    }
  } finally {
    library.destroy();
  }
}

/**
 * Render every page of a PDF to a Jimp image. Best-effort per page: a page that
 * fails to render is skipped rather than sinking the whole job.
 *
 * Prefer `forEachPdfPage` for raster encoders — this array form holds every page
 * in memory at once and is only appropriate where the caller genuinely needs all
 * pages together (e.g. compositing them into a single image).
 */
export async function pdfToImages(pdf: Buffer): Promise<Jimp[]> {
  const images: Jimp[] = [];
  await forEachPdfPage(pdf, (img) => images.push(img));
  return images;
}
