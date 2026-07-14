// Temp-file sweeper. Documents live in Neon only as a short-lived buffer:
//   • uploads with no order after 2h are deleted, and
//   • file bytes are cleared once their order is COMPLETED (keep the metadata).
// Nothing is retained long-term (privacy + DB size).
import { prisma } from "./prisma";

const STALE_MS = 2 * 60 * 60 * 1000; // 2 hours
const SWEEP_MS = 30 * 60 * 1000;     // every 30 min

async function sweep() {
  const cutoff = new Date(Date.now() - STALE_MS);

  // 1) Orphan uploads (never turned into an order) → delete.
  const orphans = await prisma.document.deleteMany({
    where: { createdAt: { lt: cutoff }, order: null, deleted: false },
  });

  // 2) Completed orders → drop the stored bytes, keep the record.
  const done = await prisma.document.updateMany({
    where: { deleted: false, fileData: { not: null }, order: { status: "COMPLETED" } },
    data: { fileData: null, deleted: true },
  });

  if (orphans.count || done.count) {
    console.log(`[cleanup] removed ${orphans.count} orphan upload(s), cleared ${done.count} completed file(s)`);
  }
}

export function startCleanup() {
  setInterval(() => sweep().catch((e) => console.error("[cleanup]", e)), SWEEP_MS);
  console.log("[cleanup] temp-file sweeper started (2h orphan TTL)");
}
