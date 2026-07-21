// Customer refund requests, and the shop's answer to them.
//
// Three audiences on one router, each scoped by who is asking:
//   • the customer  — /            raise, track, withdraw, escalate
//   • the shop      — /vendor/*    its own queue, approve/reject
//   • staff         — /admin/*     everything, plus escalations
//
// Scoping is done from the token, never from the request body.
import { Router, type NextFunction, type RequestHandler, type Response } from "express";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";
import { isVendorRole, requireVendorId } from "../lib/vendorScope";
import {
  REASON_HINTS,
  REASON_LABELS,
  REQUESTABLE_REASONS,
  REQUEST_WINDOW_DAYS,
  MAX_DESCRIPTION,
  MIN_DESCRIPTION,
  STATUS_LABELS,
  createRequestSchema,
  decisionSchema,
  escalateSchema,
  staffDecisionSchema,
  type RefundRequestStatus,
} from "./types";
import {
  createRequest,
  decide,
  escalate,
  getForUser,
  listForAdmin,
  listForUser,
  listForVendor,
  requestableState,
  resolveEscalation,
  stats,
  withdraw,
} from "./service";

export const refundRequestsRouter = Router();

/** Express 4 drops a rejected promise from an async handler; this catches it. */
function asyncRoute(
  handler: (req: AuthedRequest, res: Response, next: NextFunction) => Promise<unknown>
): RequestHandler {
  return (req, res, next) => {
    handler(req as AuthedRequest, res, next).catch(next);
  };
}

const CREATE_ERRORS: Record<string, { status: number; message: string }> = {
  ORDER_NOT_FOUND: { status: 404, message: "Order not found." },
  NOT_REFUNDABLE_STATUS: {
    status: 409,
    message: "This order isn't at a stage where a refund can be requested.",
  },
  NOTHING_PAID: { status: 409, message: "This order cost nothing, so there's nothing to refund." },
  WINDOW_CLOSED: {
    status: 409,
    message: `Refunds can be requested within ${REQUEST_WINDOW_DAYS} days of an order.`,
  },
  ALREADY_REFUNDED: { status: 409, message: "This order has already been refunded." },
  ALREADY_REQUESTED: { status: 409, message: "You've already requested a refund for this order." },
};

// ── Vocabulary the app renders its form from ────────────────────────────────
refundRequestsRouter.get("/reasons", requireAuth, (_req, res) => {
  res.json({
    reasons: REQUESTABLE_REASONS.map((value) => ({
      value,
      label: REASON_LABELS[value],
      hint: REASON_HINTS[value],
    })),
    statusLabels: STATUS_LABELS,
    windowDays: REQUEST_WINDOW_DAYS,
    minDescription: MIN_DESCRIPTION,
    maxDescription: MAX_DESCRIPTION,
  });
});

// ── The customer's own requests ─────────────────────────────────────────────
refundRequestsRouter.get(
  "/",
  requireAuth,
  asyncRoute(async (req, res) => {
    res.json({ requests: await listForUser(req.user!.userId) });
  })
);

/** Can this order still be asked about? Drives the button state in the app. */
refundRequestsRouter.get(
  "/orders/:orderId/eligibility",
  requireAuth,
  asyncRoute(async (req, res) => {
    const state = await requestableState(req.user!.userId, req.params.orderId);
    if (!state) return res.status(404).json({ error: "Order not found." });
    res.json(state);
  })
);

refundRequestsRouter.post(
  "/orders/:orderId",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = createRequestSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid request" });
    }

    const result = await createRequest(req.user!.userId, req.params.orderId, parsed.data);
    if (!result.ok) {
      const err = CREATE_ERRORS[result.reason] || {
        status: 400,
        message: "Could not raise that request.",
      };
      return res.status(err.status).json({ error: err.message });
    }

    res.status(201).json({ request: result.request });
  })
);

// ── Vendor queue ────────────────────────────────────────────────────────────
// Declared before /:id so "vendor" is never read as a request id.
refundRequestsRouter.get(
  "/vendor/queue",
  requireAuth,
  asyncRoute(async (req, res) => {
    const vendorId = await requireVendorId(req, res);
    if (!vendorId) return; // requireVendorId already replied

    const q = req.query as Record<string, string>;
    const result = await listForVendor(vendorId, {
      status: q.status as RefundRequestStatus | undefined,
      limit: parseInt(q.limit) || 50,
      skip: parseInt(q.offset) || 0,
    });
    res.json({ ...result, stats: await stats(vendorId) });
  })
);

refundRequestsRouter.post(
  "/vendor/:id/decide",
  requireAuth,
  asyncRoute(async (req, res) => {
    const vendorId = await requireVendorId(req, res);
    if (!vendorId) return;

    const parsed = decisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid decision" });
    }
    // A "no" with no explanation is what makes customers escalate, so it is
    // required here even though the schema allows the field to be absent.
    if (parsed.data.decision === "REJECT" && !parsed.data.note?.trim()) {
      return res.status(400).json({ error: "Please tell the customer why you're turning this down." });
    }

    const result = await decide(
      req.params.id,
      vendorId,
      req.user!.userId,
      parsed.data.decision,
      parsed.data.note
    );

    if (!result.ok) {
      if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Request not found." });
      if (result.reason === "NOT_PENDING") {
        return res.status(409).json({ error: "This request has already been answered." });
      }
      return res.status(409).json({ error: result.detail || "Could not issue the refund." });
    }

    res.json({ request: result.request, pointsCredited: result.pointsCredited });
  })
);

// ── Staff ───────────────────────────────────────────────────────────────────
refundRequestsRouter.get(
  "/admin/all",
  requireAuth,
  requireRole("ADMIN"),
  asyncRoute(async (req, res) => {
    const q = req.query as Record<string, string>;
    const result = await listForAdmin({
      status: q.status as RefundRequestStatus | undefined,
      vendorId: q.vendorId || undefined,
      search: q.search || undefined,
      limit: parseInt(q.limit) || 50,
      skip: parseInt(q.offset) || 0,
    });
    res.json({ ...result, stats: await stats() });
  })
);

refundRequestsRouter.post(
  "/admin/:id/resolve",
  requireAuth,
  requireRole("ADMIN"),
  asyncRoute(async (req, res) => {
    const parsed = staffDecisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid decision" });
    }

    const result = await resolveEscalation(
      req.params.id,
      req.user!.userId,
      parsed.data.decision,
      parsed.data.note
    );

    if (!result.ok) {
      if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Request not found." });
      if (result.reason === "NOT_PENDING") {
        return res.status(409).json({ error: "This request isn't awaiting a support decision." });
      }
      return res.status(409).json({ error: result.detail || "Could not issue the refund." });
    }

    res.json({ request: result.request, pointsCredited: result.pointsCredited });
  })
);

// ── One request, and the customer's moves on it ─────────────────────────────
refundRequestsRouter.get(
  "/:id",
  requireAuth,
  asyncRoute(async (req, res) => {
    const request = await getForUser(req.user!.userId, req.params.id);
    if (!request) return res.status(404).json({ error: "Request not found." });
    res.json({ request });
  })
);

refundRequestsRouter.post(
  "/:id/withdraw",
  requireAuth,
  asyncRoute(async (req, res) => {
    const result = await withdraw(req.params.id, req.user!.userId);
    if (!result.ok) {
      if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Request not found." });
      return res.status(409).json({ error: "This request can no longer be withdrawn." });
    }
    res.json({ request: result.request });
  })
);

refundRequestsRouter.post(
  "/:id/escalate",
  requireAuth,
  asyncRoute(async (req, res) => {
    const parsed = escalateSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid input" });
    }

    const result = await escalate(req.params.id, req.user!.userId, parsed.data.note);
    if (!result.ok) {
      if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Request not found." });
      return res
        .status(409)
        .json({ error: "Only a request the shop has turned down can be escalated." });
    }
    res.json({ request: result.request });
  })
);

refundRequestsRouter.use((err: any, _req: any, res: any, next: any) => {
  if (res.headersSent) return next(err);
  console.error("[refund-requests]", err);
  res.status(500).json({ error: "Could not process that request. Please try again." });
});
