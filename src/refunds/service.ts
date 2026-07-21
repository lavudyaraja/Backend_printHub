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
import { reverseTransferForOrder } from "../lib/razorpayRoute";
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

    // Pull the shop's share back out of their linked account.
    //
    // The customer has already been credited above, from the platform's Points
    // ledger. For a routed order the shop was paid its share at capture, so
    // without this reversal the platform would eat the refund while the shop
    // kept the money. Best-effort and outside the transaction: a failure here
    // must not undo the customer's credit — it is a reconciliation problem, not
    // a reason to leave a jammed print unrefunded — so it is logged loudly for
    // ops rather than thrown.
    try {
      const reversed = await reverseTransferForOrder(order.id);
      if (reversed) {
        console.log(`[refund] reversed Route transfer for ${order.orderCode}`);
      }
    } catch (e) {
      console.error(
        `[refund] REVERSAL FAILED for ${order.orderCode} — customer was refunded but the shop's share was not clawed back. Reconcile manually.`,
        e
      );
    }

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
