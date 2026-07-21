/**
 * Issuing refunds.
 *
 * A refund is always paid in Prinsta Points, whatever the order was paid with.
 * That is a deliberate product choice: the credit is instant, so a student whose
 * print jammed can walk to the next machine and try again, instead of waiting a
 * week for a card reversal on a ₹6 job.
 *
 * Everything here runs inside one transaction — credit the balance, write the
 * ledger entry, record the refund, notify — because a refund that half-happened
 * is worse than one that didn't.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import { priceInPoints } from "../lib/points";
import { REFUND_REASON_LABEL, type RefundReason } from "./types";

export interface IssueRefundInput {
  orderId: string;
  reason: RefundReason;
  /// VENDOR_APPROVED is a shop granting a customer's request from their own
  /// console, with no staff involvement — see refundRequests/service.ts.
  origin?: "AUTOMATIC" | "MANUAL" | "VENDOR_APPROVED";
  /** Staff note, for manual refunds. */
  note?: string;
  /** The admin issuing a manual refund. */
  issuedById?: string;
}

export type IssueRefundResult =
  | { ok: true; refundId: string; pointsCredited: number; alreadyRefunded?: false }
  | { ok: true; refundId: string; pointsCredited: number; alreadyRefunded: true }
  | { ok: false; error: string; status: number };

/**
 * Refunds an order, once.
 *
 * Safe to call repeatedly: `Refund.orderId` is unique, so a second attempt hits
 * the constraint and reports the existing refund rather than paying twice. Both
 * the automatic failure hook and the console's manual button can land on the
 * same order, and neither can be trusted to have checked first.
 */
export async function issueRefund(input: IssueRefundInput): Promise<IssueRefundResult> {
  const { orderId, reason, origin = "AUTOMATIC", note, issuedById } = input;

  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true,
      userId: true,
      orderCode: true,
      costPaise: true,
      status: true,
      refund: { select: { id: true, pointsCredited: true } },
    },
  });

  if (!order) return { ok: false, error: "Order not found.", status: 404 };

  // Already refunded — report the existing one. Not an error: the caller asked
  // for the order to end up refunded, and it is.
  if (order.refund) {
    return {
      ok: true,
      refundId: order.refund.id,
      pointsCredited: order.refund.pointsCredited,
      alreadyRefunded: true,
    };
  }

  // Nothing was ever collected on an unpaid order.
  if (order.status === "PENDING_PAYMENT") {
    return { ok: false, error: "This order was never paid for, so there is nothing to refund.", status: 400 };
  }

  if (order.costPaise <= 0) {
    return { ok: false, error: "This order cost nothing, so there is nothing to refund.", status: 400 };
  }

  // Charged with ceil (see priceInPoints), so refund with ceil too — refunding
  // the floor would quietly keep a point of the user's money on every job.
  const pointsCredited = priceInPoints(order.costPaise);
  const label = REFUND_REASON_LABEL[reason] || "Refund";

  try {
    const refund = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: order.userId },
        data: { pointsBalance: { increment: pointsCredited } },
        select: { pointsBalance: true },
      });

      await tx.pointsTransaction.create({
        data: {
          userId: order.userId,
          type: "CREDIT",
          amountPoints: pointsCredited,
          balancePoints: user.pointsBalance,
          description: `${label} — refund for ${order.orderCode}`,
          orderId: order.id,
        },
      });

      const created = await tx.refund.create({
        data: {
          orderId: order.id,
          userId: order.userId,
          amountPaise: order.costPaise,
          pointsCredited,
          reason,
          origin,
          note: note || null,
          issuedById: issuedById || null,
        },
        select: { id: true },
      });

      await tx.notification.create({
        data: {
          userId: order.userId,
          title: "Refunded to your Points",
          body: `${label}. ${pointsCredited} points have been added back to your balance for order ${order.orderCode}.`,
          orderId: order.id,
        },
      });

      return created;
    });

    // No gateway leg to reverse: the full amount was collected into the platform
    // account, not split to the shop. The customer is credited from the platform
    // ledger above, and the shop simply never earns on a refunded order — the
    // settlement query excludes it. Nothing to claw back.
    return { ok: true, refundId: refund.id, pointsCredited };
  } catch (e) {
    // Two callers raced and the other one won. The order is refunded either
    // way, which is what was asked for — so read theirs back rather than
    // failing, and never retry the credit.
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.refund.findUnique({
        where: { orderId },
        select: { id: true, pointsCredited: true },
      });
      if (existing) {
        return {
          ok: true,
          refundId: existing.id,
          pointsCredited: existing.pointsCredited,
          alreadyRefunded: true,
        };
      }
    }
    throw e;
  }
}

export type PartialRefundResult =
  | { ok: true; refundId: string; pointsCredited: number; settlementPaise: number; kind: "partial" | "full" | "none" }
  | { ok: false; error: string; status: number };

/**
 * Refund the unprinted part of an interrupted print, pro-rata by pages.
 *
 * The customer paid for `pagesToPrint`; the printer stopped after `printedPages`
 * (a power cut, a jam). The pages that never came out are refunded to the
 * customer as Points, and the order's `settlementPaise` is set to the printed
 * portion — which is all the shop earns on it. The split is by page count, so
 * 6 of 10 pages leaves the shop 6/10 of the cost and refunds the customer 4/10.
 *
 * Delegates the extremes to `issueRefund`: nothing printed is a full refund,
 * everything printed is no refund at all. Idempotent through the same unique
 * `Refund.orderId` constraint — a second call reports the refund already made.
 */
export async function issuePartialRefund(
  orderId: string,
  printedPages: number
): Promise<PartialRefundResult> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      id: true, userId: true, orderCode: true, costPaise: true, status: true,
      pagesToPrint: true, refund: { select: { id: true, pointsCredited: true } },
      settlementPaise: true,
    },
  });
  if (!order) return { ok: false, error: "Order not found.", status: 404 };

  if (order.refund) {
    return {
      ok: true,
      refundId: order.refund.id,
      pointsCredited: order.refund.pointsCredited,
      settlementPaise: order.settlementPaise ?? 0,
      kind: "partial",
    };
  }

  const total = Math.max(1, order.pagesToPrint);
  const printed = Math.max(0, Math.min(printedPages, total));

  // Nothing came out — a full refund, and the shop earns nothing.
  if (printed <= 0) {
    const res = await issueRefund({ orderId, reason: "PRINTER_STUCK", origin: "AUTOMATIC" });
    if (!res.ok) return res;
    await prisma.order.update({ where: { id: order.id }, data: { printedPages: 0, settlementPaise: 0 } });
    return { ok: true, refundId: res.refundId, pointsCredited: res.pointsCredited, settlementPaise: 0, kind: "full" };
  }

  // Everything printed — nothing to refund, the shop earns the full cost.
  if (printed >= total) {
    await prisma.order.update({
      where: { id: order.id },
      data: { printedPages: total, settlementPaise: order.costPaise },
    });
    return { ok: true, refundId: "", pointsCredited: 0, settlementPaise: order.costPaise, kind: "none" };
  }

  // Refund the unprinted share. Ceil the refund so a rounding sub-paise lands in
  // the customer's favour, not the platform's — the same bias issueRefund uses.
  const refundPaise = Math.ceil((order.costPaise * (total - printed)) / total);
  const settlementPaise = order.costPaise - refundPaise;
  const pointsCredited = priceInPoints(refundPaise);

  try {
    const refund = await prisma.$transaction(async (tx) => {
      const user = await tx.user.update({
        where: { id: order.userId },
        data: { pointsBalance: { increment: pointsCredited } },
        select: { pointsBalance: true },
      });

      await tx.pointsTransaction.create({
        data: {
          userId: order.userId,
          type: "CREDIT",
          amountPoints: pointsCredited,
          balancePoints: user.pointsBalance,
          description: `Partial print — refund for ${total - printed} of ${total} unprinted page(s) on ${order.orderCode}`,
          orderId: order.id,
        },
      });

      const created = await tx.refund.create({
        data: {
          orderId: order.id,
          userId: order.userId,
          amountPaise: refundPaise,
          pointsCredited,
          reason: "PARTIAL_PRINT",
          origin: "AUTOMATIC",
          note: `${printed} of ${total} pages printed; ${total - printed} refunded.`,
        },
        select: { id: true },
      });

      await tx.order.update({
        where: { id: order.id },
        data: { printedPages: printed, settlementPaise },
      });

      await tx.notification.create({
        data: {
          userId: order.userId,
          title: "Partial refund to your Points",
          body: `Only ${printed} of ${total} pages printed on ${order.orderCode}. ${pointsCredited} points for the ${total - printed} unprinted page(s) have been added back to your balance.`,
          orderId: order.id,
        },
      });

      return created;
    });

    return { ok: true, refundId: refund.id, pointsCredited, settlementPaise, kind: "partial" };
  } catch (e) {
    if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") {
      const existing = await prisma.refund.findUnique({
        where: { orderId },
        select: { id: true, pointsCredited: true },
      });
      if (existing) {
        return { ok: true, refundId: existing.id, pointsCredited: existing.pointsCredited, settlementPaise, kind: "partial" };
      }
    }
    throw e;
  }
}

/**
 * Fired when an order lands in FAILED.
 *
 * Never throws: this runs off the back of a status update, and a refund that
 * errors must not roll back the status change that reported the failure. A
 * refund that didn't happen can still be issued by hand from the console; a
 * failure that wasn't recorded is invisible to everyone.
 */
export async function refundFailedOrder(
  orderId: string,
  reason: RefundReason = "PRINT_FAILED",
): Promise<void> {
  try {
    const res = await issueRefund({ orderId, reason, origin: "AUTOMATIC" });
    if (!res.ok) {
      console.warn(`[refunds] auto-refund skipped for ${orderId}: ${res.error}`);
    }
  } catch (e) {
    console.error(`[refunds] auto-refund failed for ${orderId}:`, e);
  }
}

/** A user's refund history, newest first. */
export async function listRefundsForUser(userId: string, limit = 50) {
  return prisma.refund.findMany({
    where: { userId },
    orderBy: { createdAt: "desc" },
    take: Math.min(limit, 200),
    select: {
      id: true,
      amountPaise: true,
      pointsCredited: true,
      reason: true,
      origin: true,
      note: true,
      createdAt: true,
      order: {
        select: {
          id: true,
          orderCode: true,
          status: true,
          document: { select: { fileName: true } },
        },
      },
    },
  });
}
