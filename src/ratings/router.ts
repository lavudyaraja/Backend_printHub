// Two-way order ratings.
//
// Which direction a submission counts as is decided here, from the signed-in
// role, and never read off the request body — see submitRating in ./service.
// Staff moderation lives in routes/admin.ts, not on this router.
import { Router, type NextFunction, type RequestHandler, type Response } from "express";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { isVendorRole, vendorIdFor } from "../lib/vendorScope";
import { prisma } from "../lib/prisma";
import {
  MAX_COMMENT_LENGTH,
  MAX_TAGS,
  RATING_WINDOW_DAYS,
  submitRatingSchema,
  tagCatalog,
  type RatingDirection,
} from "./types";
import {
  pendingForUser,
  pendingForVendor,
  ratingsByAuthor,
  ratingsForOrder,
  ratingsReceivedByUser,
  ratingsReceivedByVendor,
  submitRating,
  summarize,
  vendorReviews,
} from "./service";

export const ratingsRouter = Router();

/**
 * Express 4 does not forward a rejected promise from an async handler to the
 * error middleware — the request hangs instead. Same wrapper the complaints
 * router uses, for the same reason.
 */
function asyncRoute(
  handler: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res, next).catch(next);
  };
}

/** Which way this caller's rating points, and the shop it comes from if any. */
async function directionFor(
  req: AuthedRequest
): Promise<{ direction: RatingDirection; authorVendorId: string | null }> {
  if (isVendorRole(req.user?.role)) {
    return { direction: "VENDOR_TO_USER", authorVendorId: await vendorIdFor(req.user!.userId) };
  }
  return { direction: "USER_TO_VENDOR", authorVendorId: null };
}

/** One message per failure, phrased for the person reading it on a phone. */
const SUBMIT_ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_NOT_FOUND: { status: 404, message: "Order not found." },
  NOT_A_PARTICIPANT: { status: 403, message: "You weren't part of this order." },
  NOT_COMPLETED: { status: 409, message: "You can rate an order once the print is complete." },
  NO_VENDOR: { status: 409, message: "This order has no shop attached, so there's nothing to rate." },
  WINDOW_CLOSED: {
    status: 409,
    message: `Ratings close ${RATING_WINDOW_DAYS} days after an order completes.`,
  },
  ALREADY_RATED: { status: 409, message: "You've already rated this order." },
};

// ── Tag catalog, so no client hardcodes the list ────────────────────────────
ratingsRouter.get(
  "/tags",
  requireAuth,
  asyncRoute(async (req, res) => {
    const { direction } = await directionFor(req);
    res.json({
      direction,
      tags: tagCatalog(direction),
      maxTags: MAX_TAGS,
      maxCommentLength: MAX_COMMENT_LENGTH,
      windowDays: RATING_WINDOW_DAYS,
    });
  })
);

// ── Orders still waiting on my rating ──────────────────────────────────────
ratingsRouter.get(
  "/pending",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (isVendorRole(req.user?.role)) {
      const vendorId = await vendorIdFor(req.user!.userId);
      // A vendor login with no shop profile has served nobody yet. That is an
      // empty list, not an error.
      const orders = vendorId ? await pendingForVendor(vendorId) : [];
      return res.json({ direction: "VENDOR_TO_USER", orders });
    }
    res.json({ direction: "USER_TO_VENDOR", orders: await pendingForUser(req.user!.userId) });
  })
);

// ── Badge count for the dashboard prompt ───────────────────────────────────
ratingsRouter.get(
  "/pending-count",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (isVendorRole(req.user?.role)) {
      const vendorId = await vendorIdFor(req.user!.userId);
      const orders = vendorId ? await pendingForVendor(vendorId, 50) : [];
      return res.json({ count: orders.length });
    }
    const orders = await pendingForUser(req.user!.userId, 50);
    res.json({ count: orders.length });
  })
);

// ── Ratings I've written ───────────────────────────────────────────────────
ratingsRouter.get(
  "/mine",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ ratings: await ratingsByAuthor(req.user!.userId) });
  })
);

// ── Ratings I've received, plus my own standing ────────────────────────────
ratingsRouter.get(
  "/received",
  requireAuth,
  asyncRoute(async (req, res) => {
    if (isVendorRole(req.user?.role)) {
      const vendorId = await vendorIdFor(req.user!.userId);
      if (!vendorId) return res.json({ summary: await summarize({ vendorId: "__none__" }), ratings: [] });
      const [summary, ratings] = await Promise.all([
        summarize({ vendorId }),
        ratingsReceivedByVendor(vendorId),
      ]);
      return res.json({ summary, ratings });
    }

    const userId = req.user!.userId;
    const [summary, ratings] = await Promise.all([
      summarize({ userId }),
      ratingsReceivedByUser(userId),
    ]);
    res.json({ summary, ratings });
  })
);

// ── A shop's public reviews ────────────────────────────────────────────────
// Signed-in only: these carry reviewer names, and an open endpoint would let
// anyone scrape who prints where.
ratingsRouter.get(
  "/vendors/:vendorId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const vendor = await prisma.vendor.findUnique({
      where: { id: req.params.vendorId },
      select: { id: true, shopName: true, ratingAvg: true, ratingCount: true, bannedAt: true },
    });
    if (!vendor || vendor.bannedAt) return res.status(404).json({ error: "Shop not found" });

    const limit = Number(req.query.limit) || 20;
    const skip = Number(req.query.skip) || 0;
    const [summary, page] = await Promise.all([
      summarize({ vendorId: vendor.id }),
      vendorReviews(vendor.id, { limit, skip }),
    ]);

    res.json({
      vendor: { id: vendor.id, shopName: vendor.shopName },
      summary,
      reviews: page.reviews,
      total: page.total,
    });
  })
);

// ── Both sides' ratings for one order ──────────────────────────────────────
ratingsRouter.get(
  "/orders/:orderId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const order = await prisma.order.findUnique({
      where: { id: req.params.orderId },
      select: { id: true, userId: true, vendorId: true },
    });
    if (!order) return res.status(404).json({ error: "Order not found" });

    // Only the two parties may read the pair. Anyone else gets the same 404 the
    // order itself would give them.
    const isCustomer = order.userId === req.user!.userId;
    const vendorId = isVendorRole(req.user?.role) ? await vendorIdFor(req.user!.userId) : null;
    const isVendor = !!vendorId && order.vendorId === vendorId;
    if (!isCustomer && !isVendor && req.user?.role !== "ADMIN") {
      return res.status(404).json({ error: "Order not found" });
    }

    const ratings = await ratingsForOrder(order.id);
    res.json({
      ratings,
      // What this caller still owes, so the app can show the form or the result
      // without a second round trip.
      mine: ratings.find((r) => r.authorId === req.user!.userId) || null,
    });
  })
);

// ── Submit a rating for an order ───────────────────────────────────────────
ratingsRouter.post(
  "/orders/:orderId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = submitRatingSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid rating" });
    }

    const { direction, authorVendorId } = await directionFor(req);
    const result = await submitRating(
      {
        orderId: req.params.orderId,
        authorId: req.user!.userId,
        direction,
        authorVendorId,
      },
      parsed.data
    );

    if (!result.ok) {
      const err = SUBMIT_ERRORS[result.reason] || { status: 400, message: "Could not save rating." };
      return res.status(err.status).json({ error: err.message });
    }

    res.status(201).json({ rating: result.rating });
  })
);

ratingsRouter.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  console.error("[ratings]", err);
  res.status(500).json({ error: "Could not process the rating. Please try again." });
});
