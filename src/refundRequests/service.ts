// Refund-request persistence and the decision flow.
//
// The rule this file exists to keep in one place: a request only ever moves
// forward along one path, and the money only moves once. Approving calls
// `issueRefund`, which is itself idempotent on `Refund.orderId` — so a shop
// double-tapping Approve, or a shop approving at the same moment staff resolve
// an escalation, credits the customer exactly once.
import { Prisma } from "@prisma/client";
import { nanoid } from "nanoid";
import { prisma } from "../lib/prisma";
import { issueRefund } from "../refunds/service";
import {
  REQUESTABLE_ORDER_STATUSES,
  REQUEST_SELECT,
  REQUEST_WINDOW_DAYS,
  WITHDRAWABLE,
  type CreateRequestInput,
  type RefundRequestStatus,
} from "./types";

function windowStart(): Date {
  return new Date(Date.now() - REQUEST_WINDOW_DAYS * 24 * 60 * 60 * 1000);
}

function load(id: string) {
  return prisma.refundRequest.findUniqueOrThrow({ where: { id }, select: REQUEST_SELECT });
}

// ── Raising a request ───────────────────────────────────────────────────────

export type CreateFailure =
  | "ORDER_NOT_FOUND"
  | "NOT_REFUNDABLE_STATUS"
  | "NOTHING_PAID"
  | "WINDOW_CLOSED"
  | "ALREADY_REFUNDED"
  | "ALREADY_REQUESTED";

export type CreateResult =
  | { ok: true; request: Awaited<ReturnType<typeof load>> }
  | { ok: false; reason: CreateFailure };

export async function createRequest(
  userId: string,
  orderId: string,
  input: CreateRequestInput
): Promise<CreateResult> {
  const order = await prisma.order.findFirst({
    // Scoped to the caller in the query itself: an order they don't own is
    // reported as missing rather than forbidden, so ids can't be probed.
    where: { id: orderId, userId },
    select: {
      id: true,
      orderCode: true,
      userId: true,
      vendorId: true,
      status: true,
      costPaise: true,
      createdAt: true,
      refund: { select: { id: true } },
      refundRequest: { select: { id: true } },
    },
  });

  if (!order) return { ok: false, reason: "ORDER_NOT_FOUND" };
  if (order.refundRequest) return { ok: false, reason: "ALREADY_REQUESTED" };
  // Already refunded — usually the automatic hook got there first, which means
  // the customer has their points and doesn't need to ask.
  if (order.refund) return { ok: false, reason: "ALREADY_REFUNDED" };
  if (order.costPaise <= 0) return { ok: false, reason: "NOTHING_PAID" };
  if (!(REQUESTABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    return { ok: false, reason: "NOT_REFUNDABLE_STATUS" };
  }
  if (order.createdAt < windowStart()) return { ok: false, reason: "WINDOW_CLOSED" };

  try {
    const created = await prisma.$transaction(async (tx) => {
      const request = await tx.refundRequest.create({
        data: {
          code: "RFR-" + nanoid(6).toUpperCase(),
          orderId: order.id,
          userId,
          vendorId: order.vendorId,
          reason: input.reason,
          description: input.description,
        },
        select: { id: true },
      });

      // Tell the shop straight away. A request nobody knows about is the main
      // way these end up escalated.
      if (order.vendorId) {
        const vendor = await tx.vendor.findUnique({
          where: { id: order.vendorId },
          select: { userId: true, shopName: true },
        });
        if (vendor) {
          await tx.notification.create({
            data: {
              userId: vendor.userId,
              title: "Refund requested",
              body: `A customer has asked for a refund on order ${order.orderCode}. Open your console to review it.`,
              orderId: order.id,
            },
          });
        }
      }

      return request;
    });

    return { ok: true, request: await load(created.id) };
  } catch (e) {
    // The unique on orderId: they tapped twice on a slow connection.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      return { ok: false, reason: "ALREADY_REQUESTED" };
    }
    throw e;
  }
}

// ── The shop's decision ─────────────────────────────────────────────────────

export type DecisionFailure = "NOT_FOUND" | "NOT_PENDING" | "REFUND_FAILED";

export type DecisionResult =
  | { ok: true; request: Awaited<ReturnType<typeof load>>; pointsCredited?: number }
  | { ok: false; reason: DecisionFailure; detail?: string };

/**
 * A shop approving or rejecting.
 *
 * `vendorId` is the caller's own shop, already resolved — this function never
 * has to work out who is asking. A request belonging to another shop is
 * reported as missing.
 */
export async function decide(
  requestId: string,
  vendorId: string,
  deciderUserId: string,
  decision: "APPROVE" | "REJECT",
  note?: string
): Promise<DecisionResult> {
  const request = await prisma.refundRequest.findFirst({
    where: { id: requestId, vendorId },
    select: { id: true, status: true, orderId: true, userId: true, reason: true, code: true },
  });

  if (!request) return { ok: false, reason: "NOT_FOUND" };
  if (request.status !== "PENDING") return { ok: false, reason: "NOT_PENDING" };

  if (decision === "REJECT") {
    await prisma.refundRequest.update({
      where: { id: request.id },
      data: {
        status: "REJECTED",
        decidedById: deciderUserId,
        decidedAt: new Date(),
        decisionNote: note?.trim() || "The shop did not agree this order should be refunded.",
      },
    });

    await notifyCustomer(
      request.userId,
      request.orderId,
      "Refund request turned down",
      `The shop reviewed ${request.code} and didn't agree to a refund. If you think that's wrong, you can ask platform support to look at it.`
    );

    return { ok: true, request: await load(request.id) };
  }

  // Approve: move the money first. If the credit fails the request stays
  // PENDING, which is recoverable — marking it approved and then failing to pay
  // would leave a customer told they were refunded when they weren't.
  const refund = await issueRefund({
    orderId: request.orderId,
    reason: request.reason,
    origin: "VENDOR_APPROVED",
    note: note?.trim() || `Approved by the shop (${request.code})`,
    issuedById: deciderUserId,
  });

  if (!refund.ok) return { ok: false, reason: "REFUND_FAILED", detail: refund.error };

  await prisma.refundRequest.update({
    where: { id: request.id },
    data: {
      status: "APPROVED",
      decidedById: deciderUserId,
      decidedAt: new Date(),
      decisionNote: note?.trim() || null,
      refundId: refund.refundId,
    },
  });

  // issueRefund already notified the customer about the points landing, so
  // there is deliberately no second notification here.
  return { ok: true, request: await load(request.id), pointsCredited: refund.pointsCredited };
}

async function notifyCustomer(userId: string, orderId: string, title: string, body: string) {
  await prisma.notification.create({ data: { userId, title, body, orderId } });
}

// ── The customer's moves ────────────────────────────────────────────────────

export async function withdraw(requestId: string, userId: string) {
  const request = await prisma.refundRequest.findFirst({
    where: { id: requestId, userId },
    select: { id: true, status: true },
  });
  if (!request) return { ok: false as const, reason: "NOT_FOUND" as const };
  if (!WITHDRAWABLE.includes(request.status as RefundRequestStatus)) {
    return { ok: false as const, reason: "NOT_WITHDRAWABLE" as const };
  }

  await prisma.refundRequest.update({
    where: { id: request.id },
    data: { status: "CANCELLED" },
  });
  return { ok: true as const, request: await load(request.id) };
}

/** Disputing a rejection. Only reachable from REJECTED, and only once. */
export async function escalate(requestId: string, userId: string, note: string) {
  const request = await prisma.refundRequest.findFirst({
    where: { id: requestId, userId },
    select: { id: true, status: true, code: true },
  });
  if (!request) return { ok: false as const, reason: "NOT_FOUND" as const };
  if (request.status !== "REJECTED") {
    return { ok: false as const, reason: "NOT_ESCALATABLE" as const };
  }

  await prisma.refundRequest.update({
    where: { id: request.id },
    data: { status: "ESCALATED", escalatedAt: new Date(), escalationNote: note.trim() },
  });
  return { ok: true as const, request: await load(request.id) };
}

// ── Staff resolving an escalation ───────────────────────────────────────────

export async function resolveEscalation(
  requestId: string,
  adminId: string,
  decision: "APPROVE" | "REJECT",
  note?: string
): Promise<DecisionResult> {
  const request = await prisma.refundRequest.findUnique({
    where: { id: requestId },
    select: { id: true, status: true, orderId: true, userId: true, reason: true, code: true },
  });

  if (!request) return { ok: false, reason: "NOT_FOUND" };
  if (request.status !== "ESCALATED") return { ok: false, reason: "NOT_PENDING" };

  if (decision === "REJECT") {
    await prisma.refundRequest.update({
      where: { id: request.id },
      data: {
        status: "ESCALATION_REJECTED",
        staffNote: note?.trim() || "Support reviewed this and agreed with the shop's decision.",
        resolvedById: adminId,
        resolvedAt: new Date(),
      },
    });
    await notifyCustomer(
      request.userId,
      request.orderId,
      "Support reviewed your refund request",
      note?.trim() || `We looked at ${request.code} and agreed with the shop's decision.`
    );
    return { ok: true, request: await load(request.id) };
  }

  const refund = await issueRefund({
    orderId: request.orderId,
    reason: request.reason,
    origin: "MANUAL",
    note: note?.trim() || `Escalation upheld by staff (${request.code})`,
    issuedById: adminId,
  });
  if (!refund.ok) return { ok: false, reason: "REFUND_FAILED", detail: refund.error };

  await prisma.refundRequest.update({
    where: { id: request.id },
    data: {
      status: "ESCALATION_APPROVED",
      staffNote: note?.trim() || null,
      resolvedById: adminId,
      resolvedAt: new Date(),
      refundId: refund.refundId,
    },
  });

  return { ok: true, request: await load(request.id), pointsCredited: refund.pointsCredited };
}

// ── Reads ───────────────────────────────────────────────────────────────────

export async function listForUser(userId: string, limit = 50) {
  return prisma.refundRequest.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: limit,
    select: REQUEST_SELECT,
  });
}

export async function getForUser(userId: string, id: string) {
  return prisma.refundRequest.findFirst({ where: { id, userId }, select: REQUEST_SELECT });
}

/** Whether this order can still be asked about, for the app's button state. */
export async function requestableState(userId: string, orderId: string) {
  const order = await prisma.order.findFirst({
    where: { id: orderId, userId },
    select: {
      id: true,
      status: true,
      costPaise: true,
      createdAt: true,
      refund: { select: { id: true } },
      refundRequest: { select: REQUEST_SELECT },
    },
  });
  if (!order) return null;

  const reasons: string[] = [];
  if (order.refundRequest) reasons.push("ALREADY_REQUESTED");
  if (order.refund) reasons.push("ALREADY_REFUNDED");
  if (order.costPaise <= 0) reasons.push("NOTHING_PAID");
  if (!(REQUESTABLE_ORDER_STATUSES as readonly string[]).includes(order.status)) {
    reasons.push("NOT_REFUNDABLE_STATUS");
  }
  if (order.createdAt < windowStart()) reasons.push("WINDOW_CLOSED");

  return {
    canRequest: reasons.length === 0,
    blockedBy: reasons,
    existing: order.refundRequest,
  };
}

export interface VendorQueueFilter {
  status?: RefundRequestStatus;
  limit?: number;
  skip?: number;
}

export async function listForVendor(vendorId: string, filter: VendorQueueFilter = {}) {
  const where: Prisma.RefundRequestWhereInput = { vendorId };
  if (filter.status) where.status = filter.status;

  const take = Math.min(filter.limit ?? 50, 200);
  const [requests, total, pending] = await Promise.all([
    prisma.refundRequest.findMany({
      where,
      // Oldest first when filtering to the queue: the one that has been waiting
      // longest is the one most likely to be escalated.
      orderBy: { createdAt: filter.status === "PENDING" ? "asc" : "desc" },
      take,
      skip: filter.skip ?? 0,
      select: REQUEST_SELECT,
    }),
    prisma.refundRequest.count({ where }),
    prisma.refundRequest.count({ where: { vendorId, status: "PENDING" } }),
  ]);

  return { requests, total, pending };
}

export interface AdminFilter {
  status?: RefundRequestStatus;
  vendorId?: string;
  search?: string;
  limit?: number;
  skip?: number;
}

export async function listForAdmin(filter: AdminFilter = {}) {
  const where: Prisma.RefundRequestWhereInput = {};
  if (filter.status) where.status = filter.status;
  if (filter.vendorId) where.vendorId = filter.vendorId;

  const search = filter.search?.trim();
  if (search) {
    where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { description: { contains: search, mode: "insensitive" } },
      { order: { orderCode: { contains: search, mode: "insensitive" } } },
      { user: { name: { contains: search, mode: "insensitive" } } },
      { vendor: { shopName: { contains: search, mode: "insensitive" } } },
    ];
  }

  const take = Math.min(filter.limit ?? 50, 200);
  const [requests, total] = await Promise.all([
    prisma.refundRequest.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take,
      skip: filter.skip ?? 0,
      select: REQUEST_SELECT,
    }),
    prisma.refundRequest.count({ where }),
  ]);

  return { requests, total };
}

/** Headline counts for the admin and vendor queues. */
export async function stats(vendorId?: string) {
  const scope = vendorId ? { vendorId } : {};
  const [total, pending, approved, rejected, escalated] = await Promise.all([
    prisma.refundRequest.count({ where: scope }),
    prisma.refundRequest.count({ where: { ...scope, status: "PENDING" } }),
    prisma.refundRequest.count({
      where: { ...scope, status: { in: ["APPROVED", "ESCALATION_APPROVED"] } },
    }),
    prisma.refundRequest.count({
      where: { ...scope, status: { in: ["REJECTED", "ESCALATION_REJECTED"] } },
    }),
    prisma.refundRequest.count({ where: { ...scope, status: "ESCALATED" } }),
  ]);

  return { total, pending, approved, rejected, escalated };
}
