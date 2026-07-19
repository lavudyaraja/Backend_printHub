/** Shared refund vocabulary — the API and both consoles read these. */

export const REFUND_REASONS = [
  "PRINT_FAILED",
  "PRINTER_STUCK",
  "PRINTER_OFFLINE",
  "PARTIAL_PRINT",
  "CANCELLED_BY_USER",
  "ADMIN_GOODWILL",
  "OTHER",
] as const;

export type RefundReason = (typeof REFUND_REASONS)[number];

/** Plain-English labels. The user sees these on their points ledger. */
export const REFUND_REASON_LABEL: Record<RefundReason, string> = {
  PRINT_FAILED: "Print failed",
  PRINTER_STUCK: "Printer got stuck mid-print",
  PRINTER_OFFLINE: "Printer went offline",
  PARTIAL_PRINT: "Only some pages printed",
  CANCELLED_BY_USER: "Order cancelled",
  ADMIN_GOODWILL: "Goodwill refund",
  OTHER: "Refund",
};

/**
 * Order states a refund may be issued from.
 *
 * PENDING_PAYMENT is absent on purpose: nothing was ever taken, so there is
 * nothing to give back. COMPLETED is present because a print can come out
 * unusable — smudged, blank, half-done — and staff still need to make it right.
 */
export const REFUNDABLE_STATUSES = ["PAID", "READY", "PRINTING", "FAILED", "CANCELLED", "COMPLETED"] as const;
