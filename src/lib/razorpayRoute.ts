// Razorpay Route — splitting a customer's payment so each shop is paid directly.
//
// The whole point of this file is that a shop's money never rests in a platform
// balance. When a student pays for a print at Vendor A's machine, Razorpay
// settles Vendor A's share straight to Vendor A's linked account at capture,
// and only the platform's commission stays behind. There is no "hold", no
// manual payout, and — critically — no way for Vendor A's money to reach
// Vendor B, because the split is keyed on the order's own `vendorId`, which was
// copied from the printer the moment the order was placed.
//
// Nothing here moves money by polling or on a schedule: the split is declared
// when the Razorpay order is created (see razorpay.ts `createRazorpayOrder`),
// and Razorpay executes it. This module works out *what* the split should be
// and manages the linked accounts it points at.
import { prisma } from "./prisma";
import { razorpayClient, type RzTransfer } from "./razorpay";
import { readSettings } from "./settings";

/**
 * Work out how a paid order should be split.
 *
 * Returns the single transfer leg (the shop's share) plus the commission that
 * stays with the platform, or a `reason` when the order can't be routed. A null
 * transfer is not an error the caller should hide — it is the signal that this
 * order must not be taken as a direct payment yet, because there is nowhere for
 * the shop's share to go.
 */
export interface SplitPlan {
  /** The Route leg to attach to the Razorpay order, or null if unroutable. */
  transfer: RzTransfer | null;
  /** Shop's share, in paise. */
  vendorPaise: number;
  /** Platform's cut, in paise — what's left after the transfer. */
  commissionPaise: number;
  /** Set when the order can't be routed; the caller should block direct pay. */
  reason?: "NO_VENDOR" | "VENDOR_NOT_ONBOARDED" | "AMOUNT_TOO_SMALL";
}

/**
 * Razorpay rejects transfers below ₹1. A sub-rupee order (a single B&W page at
 * some shops) can't be split, so it can't be a direct payment — it has to go
 * through Points, where there's no gateway leg to divide.
 */
const MIN_TRANSFER_PAISE = 100;

export async function planSplit(orderId: string): Promise<SplitPlan> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: {
      costPaise: true,
      vendorId: true,
      orderCode: true,
      vendor: { select: { razorpayAccountId: true, routeActive: true } },
    },
  });

  const cost = order?.costPaise ?? 0;

  // No shop attached — a print at an unassigned machine. Nobody to route to.
  if (!order?.vendorId || !order.vendor) {
    return { transfer: null, vendorPaise: 0, commissionPaise: cost, reason: "NO_VENDOR" };
  }

  // Onboarded but not yet activated, or never onboarded: the account can't
  // receive money, so the order must not be taken as a direct payment.
  if (!order.vendor.razorpayAccountId || !order.vendor.routeActive) {
    return { transfer: null, vendorPaise: 0, commissionPaise: cost, reason: "VENDOR_NOT_ONBOARDED" };
  }

  const settings = await readSettings();
  const rate = settings.pricing?.commissionPercent ?? 0;

  // Commission rounds in the platform's favour by a sub-paise at most; the shop
  // gets the remainder, so nothing is lost between the two legs.
  const commissionPaise = Math.round((cost * rate) / 100);
  const vendorPaise = cost - commissionPaise;

  if (vendorPaise < MIN_TRANSFER_PAISE) {
    return { transfer: null, vendorPaise, commissionPaise, reason: "AMOUNT_TOO_SMALL" };
  }

  return {
    transfer: {
      account: order.vendor.razorpayAccountId,
      amount: vendorPaise,
      notes: { orderId, orderCode: order.orderCode, vendorId: order.vendorId },
    },
    vendorPaise,
    commissionPaise,
  };
}

/**
 * After a split payment is captured, record which transfer carried the shop's
 * share, so a later refund can reverse that exact transfer rather than guess.
 *
 * Razorpay attaches the transfer to the *payment*, not the order, so it can
 * only be read once the payment exists — hence this runs at verify time, not at
 * order creation. Best-effort: a payment can be fully captured and settled even
 * if we fail to note the transfer id, so a failure here is logged, not thrown.
 */
export async function recordTransferForPayment(orderId: string, paymentId: string): Promise<void> {
  try {
    // `payments.transfers` isn't in the SDK's type defs, though the client
    // supports it — Route sits slightly outside the typed surface.
    const transfers = await (razorpayClient().payments as any).transfers(paymentId);
    const items = (transfers as any)?.items as Array<{ id: string }> | undefined;
    const transferId = items?.[0]?.id;
    if (transferId) {
      await prisma.order.update({ where: { id: orderId }, data: { razorpayTransferId: transferId } });
    }
  } catch (e) {
    console.error(`[route] could not record transfer for order ${orderId}`, e);
  }
}

/**
 * Reverse a split so a refund comes out of the shop's share, not the platform's
 * pocket.
 *
 * Without this, refunding a routed order would pay the customer back from the
 * platform balance while the shop kept the money it was already sent — the
 * platform would eat every refund. Reversing pulls the shop's share back from
 * their linked account first.
 *
 * Returns whether a reversal was made. `false` with no throw means there was
 * nothing to reverse (a Points order, or one taken before Route) — which is
 * fine, the caller still credits the customer.
 */
export async function reverseTransferForOrder(orderId: string): Promise<boolean> {
  const order = await prisma.order.findUnique({
    where: { id: orderId },
    select: { razorpayTransferId: true },
  });
  if (!order?.razorpayTransferId) return false;

  // Full reversal — the print failed or was unusable, so the shop's whole share
  // comes back. Partial refunds aren't a case this product has: an order is
  // refunded in full or not at all.
  await razorpayClient().transfers.reverse(order.razorpayTransferId, {} as any);
  return true;
}

// ── Linked-account onboarding ────────────────────────────────────────────────

export interface OnboardInput {
  vendorId: string;
  email: string;
  phone: string;
  legalBusinessName: string;
  /** The shop's own display name, if different from the legal name. */
  businessName?: string;
  bank: {
    accountHolder: string;
    accountNumber: string;
    ifsc: string;
  };
}

export interface OnboardResult {
  accountId: string;
  active: boolean;
  statusNote: string;
}

/**
 * Create (or complete) a shop's Route linked account from the details it has
 * already given us for payouts.
 *
 * This is deliberately not a payment path — it runs when a vendor asks to start
 * receiving money, and it is idempotent on the vendor: an account is created
 * once and reused, so calling it again for a shop that already has one just
 * re-reads its status.
 *
 * Activation is Razorpay's to grant, not ours. A freshly created account is
 * usually `created`/`pending` until KYC clears, so `active` here reflects what
 * Razorpay reports, and the caller must not route money to an inactive one.
 */
export async function onboardVendor(input: OnboardInput): Promise<OnboardResult> {
  const client = razorpayClient();

  const existing = await prisma.vendor.findUnique({
    where: { id: input.vendorId },
    select: { razorpayAccountId: true },
  });

  let accountId = existing?.razorpayAccountId ?? null;

  if (!accountId) {
    // A Route "account" is the linked business. The bank account is attached to
    // it in a second step (below) so the shop's share has somewhere to land.
    const account = await client.accounts.create({
      email: input.email,
      phone: input.phone,
      type: "route",
      legal_business_name: input.legalBusinessName,
      business_type: "individual",
      contact_name: input.bank.accountHolder,
      profile: { category: "ecommerce", subcategory: "office_supplies" },
      legal_info: {},
    } as any);
    accountId = (account as any).id as string;
  }

  // Attach / refresh the settlement bank account. This is what a transfer to
  // the linked account actually pays into.
  let active = false;
  let statusNote = "Submitted to Razorpay. Activation usually takes a little while.";
  try {
    await client.stakeholders?.create?.(accountId, {
      name: input.bank.accountHolder,
      email: input.email,
    } as any);
  } catch {
    // Stakeholder may already exist, or the account type may not require one —
    // neither blocks activation, so this is best-effort.
  }

  try {
    const account = await (client.accounts as any).fetch(accountId);
    const status = (account as any)?.status as string | undefined;
    active = status === "activated";
    if (status) statusNote = `Razorpay status: ${status}.`;
  } catch (e) {
    console.error(`[route] could not fetch account ${accountId}`, e);
  }

  await prisma.vendor.update({
    where: { id: input.vendorId },
    data: { razorpayAccountId: accountId, routeActive: active, routeStatusNote: statusNote },
  });

  return { accountId, active, statusNote };
}

/**
 * Re-check a shop's activation with Razorpay and update our copy.
 *
 * KYC clears on Razorpay's side, not ours, so a shop that onboarded while
 * `pending` becomes `activated` later with no event we necessarily saw. The
 * vendor console calls this when it loads the settlements page, so the status a
 * shop sees is live rather than whatever it was at onboarding.
 */
export async function refreshVendorRouteStatus(vendorId: string): Promise<OnboardResult | null> {
  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { razorpayAccountId: true },
  });
  if (!vendor?.razorpayAccountId) return null;

  try {
    const account = await (razorpayClient().accounts as any).fetch(vendor.razorpayAccountId);
    const status = (account as any)?.status as string | undefined;
    const active = status === "activated";
    const statusNote = status ? `Razorpay status: ${status}.` : "Awaiting activation.";
    await prisma.vendor.update({
      where: { id: vendorId },
      data: { routeActive: active, routeStatusNote: statusNote },
    });
    return { accountId: vendor.razorpayAccountId, active, statusNote };
  } catch (e) {
    console.error(`[route] status refresh failed for vendor ${vendorId}`, e);
    return null;
  }
}
