// Rating persistence.
//
// Two rules live here and nowhere else:
//
//   1. Only the two parties to a completed order may rate it, and each may do
//      so once. Everything public is filtered to VISIBLE.
//   2. Vendor.ratingAvg / User.ratingAvg are derived values. They are only ever
//      written by `recomputeVendorRating` / `recomputeUserRating`, inside the
//      same transaction as the rating that changed them, so a crash between the
//      two cannot leave an average that disagrees with the rows behind it.
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  EMPTY_SUMMARY,
  RATING_ADMIN_SELECT,
  RATING_SELECT,
  RATING_WINDOW_DAYS,
  sanitizeTags,
  type RatingDirection,
  type RatingSummary,
  type SubmitRatingInput,
} from "./types";

/** Only a finished print can be rated — nothing else has happened yet. */
const RATABLE_STATUS = "COMPLETED" as const;

function windowStart(): Date {
  return new Date(Date.now() - RATING_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

// ── Aggregates ──────────────────────────────────────────────────────────────

/**
 * Recalculate a shop's average from its VISIBLE ratings and write it back.
 *
 * Takes the transaction client rather than the global `prisma` so it runs
 * inside the caller's transaction: the average and the rating it reflects have
 * to land together or not at all.
 */
async function recomputeVendorRating(tx: Prisma.TransactionClient, vendorId: string) {
  const agg = await tx.rating.aggregate({
    where: { vendorId, direction: "USER_TO_VENDOR", status: "VISIBLE" },
    _avg: { stars: true },
    _count: { _all: true },
  });
  await tx.vendor.update({
    where: { id: vendorId },
    data: {
      // Averages are shown to one decimal; storing the rounded value keeps what
      // is displayed and what is sorted on the same number.
      ratingAvg: Math.round((agg._avg.stars ?? 0) * 10) / 10,
      ratingCount: agg._count._all,
    },
  });
}

/** The same, for a customer's standing. */
async function recomputeUserRating(tx: Prisma.TransactionClient, userId: string) {
  const agg = await tx.rating.aggregate({
    where: { userId, direction: "VENDOR_TO_USER", status: "VISIBLE" },
    _avg: { stars: true },
    _count: { _all: true },
  });
  await tx.user.update({
    where: { id: userId },
    data: {
      ratingAvg: Math.round((agg._avg.stars ?? 0) * 10) / 10,
      ratingCount: agg._count._all,
    },
  });
}

/** Refresh whichever side a rating in this direction feeds. */
async function recomputeFor(
  tx: Prisma.TransactionClient,
  direction: RatingDirection,
  ids: { userId: string; vendorId: string }
) {
  if (direction === "USER_TO_VENDOR") return recomputeVendorRating(tx, ids.vendorId);
  return recomputeUserRating(tx, ids.userId);
}

// ── Submitting ──────────────────────────────────────────────────────────────

export type SubmitFailure =
  | "ORDER_NOT_FOUND"
  | "NOT_A_PARTICIPANT"
  | "NOT_COMPLETED"
  | "NO_VENDOR"
  | "WINDOW_CLOSED"
  | "ALREADY_RATED";

export type SubmitResult =
  | { ok: true; rating: Awaited<ReturnType<typeof loadRating>> }
  | { ok: false; reason: SubmitFailure };

function loadRating(id: string) {
  return prisma.rating.findUniqueOrThrow({ where: { id }, select: RATING_SELECT });
}

/**
 * Record one side's rating of an order.
 *
 * `direction` is derived from who is asking rather than taken from the request:
 * a student posting `VENDOR_TO_USER` would otherwise be rating themselves on
 * behalf of a shop. The caller's vendor id is passed in already resolved (the
 * router has `requireVendorId` for that) so this function never has to work out
 * what kind of account it is dealing with.
 */
export async function submitRating(
  opts: {
    orderId: string;
    authorId: string;
    direction: RatingDirection;
    /** Set only when the author is a vendor — the shop they are rating from. */
    authorVendorId?: string | null;
  },
  input: SubmitRatingInput
): Promise<SubmitResult> {
  const order = await prisma.order.findUnique({
    where: { id: opts.orderId },
    select: { id: true, userId: true, vendorId: true, status: true, updatedAt: true },
  });

  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (!order.vendorId) return { ok: false, reason: "NO_VENDOR" };

  // Confirm the author was actually on this order. A student must own it; a
  // vendor must be the shop that printed it. Anyone else is told the order does
  // not exist rather than that they may not touch it — order ids are short
  // enough to guess at, and "forbidden" would confirm a hit.
  if (opts.direction === "USER_TO_VENDOR") {
    if (order.userId !== opts.authorId) return { ok: false, reason: "ORDER_NOT_FOUND" };
  } else {
    if (!opts.authorVendorId || order.vendorId !== opts.authorVendorId) {
      return { ok: false, reason: "ORDER_NOT_FOUND" };
    }
    // A shop rating its own login's order would be rating itself.
    if (order.userId === opts.authorId) return { ok: false, reason: "NOT_A_PARTICIPANT" };
  }

  if (order.status !== RATABLE_STATUS) return { ok: false, reason: "NOT_COMPLETED" };
  if (order.updatedAt < windowStart()) return { ok: false, reason: "WINDOW_CLOSED" };

  const tags = sanitizeTags(opts.direction, input.tags ?? []);
  const comment = input.comment?.trim() || null;

  try {
    const created = await prisma.$transaction(async (tx) => {
      const rating = await tx.rating.create({
        data: {
          orderId: order.id,
          direction: opts.direction,
          stars: input.stars,
          comment,
          tags,
          authorId: opts.authorId,
          userId: order.userId,
          vendorId: order.vendorId!,
        },
        select: { id: true },
      });
      await recomputeFor(tx, opts.direction, { userId: order.userId, vendorId: order.vendorId! });
      return rating;
    });

    return { ok: true, rating: await loadRating(created.id) };
  } catch (e) {
    // P2002 is the [orderId, direction] unique constraint: this side has
    // already rated. Letting the database answer that, rather than checking
    // first, is what makes a double-tap on a slow connection safe.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, reason: "ALREADY_RATED" };
    }
    throw e;
  }
}

// ── Reading ─────────────────────────────────────────────────────────────────

/**
 * Orders this student has finished but not yet rated, newest first. Drives the
 * "how did it go?" prompt on the dashboard.
 */
export async function pendingForUser(userId: string, limit = 20) {
  return prisma.order.findMany({
    where: {
      userId,
      status: RATABLE_STATUS,
      vendorId: { not: null },
      updatedAt: { gte: windowStart() },
      // `none` rather than a join-and-filter: the unique constraint means there
      // is at most one row to look for.
      ratings: { none: { direction: "USER_TO_VENDOR" } },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      orderCode: true,
      createdAt: true,
      updatedAt: true,
      pagesToPrint: true,
      vendor: { select: { id: true, shopName: true, ratingAvg: true, ratingCount: true } },
      printer: { select: { id: true, name: true, locationName: true } },
    },
  });
}

/** The same, for a shop: customers it has served but not yet rated. */
export async function pendingForVendor(vendorId: string, limit = 20) {
  return prisma.order.findMany({
    where: {
      vendorId,
      status: RATABLE_STATUS,
      updatedAt: { gte: windowStart() },
      ratings: { none: { direction: "VENDOR_TO_USER" } },
    },
    orderBy: { updatedAt: "desc" },
    take: limit,
    select: {
      id: true,
      orderCode: true,
      createdAt: true,
      updatedAt: true,
      pagesToPrint: true,
      user: { select: { id: true, name: true, ratingAvg: true, ratingCount: true } },
      printer: { select: { id: true, name: true, locationName: true } },
    },
  });
}

/** Both sides' ratings for one order, for whoever was on it. */
export async function ratingsForOrder(orderId: string) {
  return prisma.rating.findMany({
    where: { orderId },
    orderBy: { createdAt: "asc" },
    select: RATING_SELECT,
  });
}

/** Ratings this account has written, newest first. */
export async function ratingsByAuthor(authorId: string, limit = 50) {
  return prisma.rating.findMany({
    where: { authorId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: RATING_SELECT,
  });
}

/**
 * A shop's public reviews. Hidden rows are filtered out here rather than by the
 * caller — this is the function the app hits, and a moderated review reappearing
 * because one route forgot the filter is exactly the failure worth designing
 * out.
 */
export async function vendorReviews(vendorId: string, opts: { limit?: number; skip?: number } = {}) {
  const [reviews, total] = await Promise.all([
    prisma.rating.findMany({
      where: { vendorId, direction: "USER_TO_VENDOR", status: "VISIBLE" },
      orderBy: { createdAt: "desc" },
      take: Math.min(opts.limit ?? 20, 100),
      skip: opts.skip ?? 0,
      select: RATING_SELECT,
    }),
    prisma.rating.count({
      where: { vendorId, direction: "USER_TO_VENDOR", status: "VISIBLE" },
    }),
  ]);
  return { reviews, total };
}

/** Ratings a shop has received, for its own console. Same rows, same filter. */
export async function ratingsReceivedByVendor(vendorId: string, limit = 50) {
  return prisma.rating.findMany({
    where: { vendorId, direction: "USER_TO_VENDOR", status: "VISIBLE" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: RATING_SELECT,
  });
}

/** Ratings a student has received from shops. */
export async function ratingsReceivedByUser(userId: string, limit = 50) {
  return prisma.rating.findMany({
    where: { userId, direction: "VENDOR_TO_USER", status: "VISIBLE" },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: RATING_SELECT,
  });
}

/**
 * Average, count and star histogram for one subject.
 *
 * `groupBy` gives all five buckets in one query; the missing ones are filled in
 * so callers can always index 1–5 without a presence check.
 */
export async function summarize(
  subject: { vendorId: string } | { userId: string }
): Promise<RatingSummary> {
  const where =
    "vendorId" in subject
      ? { vendorId: subject.vendorId, direction: "USER_TO_VENDOR" as const, status: "VISIBLE" as const }
      : { userId: subject.userId, direction: "VENDOR_TO_USER" as const, status: "VISIBLE" as const };

  const groups = await prisma.rating.groupBy({
    by: ["stars"],
    where,
    _count: { _all: true },
  });

  if (groups.length === 0) return { ...EMPTY_SUMMARY, breakdown: { ...EMPTY_SUMMARY.breakdown } };

  const breakdown = { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 } as RatingSummary["breakdown"];
  let total = 0;
  let sum = 0;
  for (const g of groups) {
    const stars = g.stars as 1 | 2 | 3 | 4 | 5;
    if (stars >= 1 && stars <= 5) breakdown[stars] = g._count._all;
    total += g._count._all;
    sum += stars * g._count._all;
  }

  return {
    average: total ? Math.round((sum / total) * 10) / 10 : 0,
    count: total,
    breakdown,
  };
}

// ── Moderation (admin only) ─────────────────────────────────────────────────

export interface AdminRatingFilter {
  direction?: RatingDirection;
  status?: "VISIBLE" | "HIDDEN";
  vendorId?: string;
  userId?: string;
  /** Only ratings at or below this many stars — the complaints, in practice. */
  maxStars?: number;
  search?: string;
  skip?: number;
  limit?: number;
}

/** The moderation queue. Returns the page plus the unfiltered-by-page total. */
export async function listRatingsForAdmin(filter: AdminRatingFilter) {
  const where: Prisma.RatingWhereInput = {};
  if (filter.direction) where.direction = filter.direction;
  if (filter.status) where.status = filter.status;
  if (filter.vendorId) where.vendorId = filter.vendorId;
  if (filter.userId) where.userId = filter.userId;
  if (filter.maxStars) where.stars = { lte: filter.maxStars };

  const search = filter.search?.trim();
  if (search) {
    where.OR = [
      { comment: { contains: search, mode: "insensitive" } },
      { order: { orderCode: { contains: search, mode: "insensitive" } } },
      { vendor: { shopName: { contains: search, mode: "insensitive" } } },
      { user: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const take = Math.min(filter.limit ?? 50, 200);
  const [ratings, total] = await Promise.all([
    prisma.rating.findMany({
      where,
      orderBy: { createdAt: "desc" },
      skip: filter.skip ?? 0,
      take,
      select: RATING_ADMIN_SELECT,
    }),
    prisma.rating.count({ where }),
  ]);

  return { ratings, total };
}

/**
 * Hide or restore a rating, and refresh the average it feeds.
 *
 * Hiding is not deletion: the row stays, so the author still counts as having
 * rated this order and cannot simply post the same thing again, and staff keep
 * a record of what was said.
 */
export async function setRatingVisibility(
  id: string,
  hidden: boolean,
  opts: { adminId: string; reason?: string }
) {
  const existing = await prisma.rating.findUnique({
    where: { id },
    select: { id: true, direction: true, userId: true, vendorId: true },
  });
  if (!existing) return null;

  return prisma.$transaction(async (tx) => {
    await tx.rating.update({
      where: { id },
      data: hidden
        ? {
            status: "HIDDEN",
            hiddenReason: opts.reason?.trim() || "Hidden by staff",
            hiddenById: opts.adminId,
            hiddenAt: new Date(),
          }
        : { status: "VISIBLE", hiddenReason: null, hiddenById: null, hiddenAt: null },
    });

    await recomputeFor(tx, existing.direction as RatingDirection, {
      userId: existing.userId,
      vendorId: existing.vendorId,
    });

    return tx.rating.findUniqueOrThrow({ where: { id }, select: RATING_ADMIN_SELECT });
  });
}

/** Headline numbers for the admin ratings page. */
export async function adminRatingStats() {
  const [total, hidden, vendorAgg, userAgg, lowStars] = await Promise.all([
    prisma.rating.count(),
    prisma.rating.count({ where: { status: "HIDDEN" } }),
    prisma.rating.aggregate({
      where: { direction: "USER_TO_VENDOR", status: "VISIBLE" },
      _avg: { stars: true },
      _count: { _all: true },
    }),
    prisma.rating.aggregate({
      where: { direction: "VENDOR_TO_USER", status: "VISIBLE" },
      _avg: { stars: true },
      _count: { _all: true },
    }),
    prisma.rating.count({ where: { status: "VISIBLE", stars: { lte: 2 } } }),
  ]);

  return {
    total,
    hidden,
    lowStars,
    vendorRatings: {
      count: vendorAgg._count._all,
      average: Math.round((vendorAgg._avg.stars ?? 0) * 10) / 10,
    },
    userRatings: {
      count: userAgg._count._all,
      average: Math.round((userAgg._avg.stars ?? 0) * 10) / 10,
    },
  };
}
