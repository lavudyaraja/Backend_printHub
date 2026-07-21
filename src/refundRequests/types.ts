// Shapes and vocabulary for customer-raised refund requests.
//
// A request is the *ask*; a Refund is the money moving. Keeping the vocabulary
// here rather than reading it off the Prisma enums lets a request be validated
// before the database is touched, and fixes the order these appear in on every
// screen.
import { z } from "zod";

export const REFUND_REQUEST_STATUSES = [
  "PENDING",
  "APPROVED",
  "REJECTED",
  "ESCALATED",
  "ESCALATION_APPROVED",
  "ESCALATION_REJECTED",
  "CANCELLED",
] as const;

export type RefundRequestStatus = (typeof REFUND_REQUEST_STATUSES)[number];

/**
 * Reasons a customer can pick. Narrower than the full RefundReason enum:
 * ADMIN_GOODWILL is a staff decision and CANCELLED_BY_USER is a system event,
 * so neither belongs on a form a student fills in.
 */
export const REQUESTABLE_REASONS = [
  "PRINT_FAILED",
  "PRINTER_STUCK",
  "PRINTER_OFFLINE",
  "PARTIAL_PRINT",
  "OTHER",
] as const;

export type RequestableReason = (typeof REQUESTABLE_REASONS)[number];

export const REASON_LABELS: Record<RequestableReason, string> = {
  PRINT_FAILED: "Nothing printed",
  PRINTER_STUCK: "Printer jammed or froze",
  PRINTER_OFFLINE: "Printer was offline",
  PARTIAL_PRINT: "Only some pages printed",
  OTHER: "Something else",
};

/** One-line hints, so a customer picks the right bucket without guessing. */
export const REASON_HINTS: Record<RequestableReason, string> = {
  PRINT_FAILED: "You were charged but no pages came out",
  PRINTER_STUCK: "The job started and never finished",
  PRINTER_OFFLINE: "The machine was off or unreachable",
  PARTIAL_PRINT: "Some pages are missing or unusable",
  OTHER: "Describe what happened in your own words",
};

export const STATUS_LABELS: Record<RefundRequestStatus, string> = {
  PENDING: "Waiting on the shop",
  APPROVED: "Refunded",
  REJECTED: "Turned down",
  ESCALATED: "With platform support",
  ESCALATION_APPROVED: "Refunded by support",
  ESCALATION_REJECTED: "Closed by support",
  CANCELLED: "Withdrawn",
};

/**
 * Order states a customer may raise a request from.
 *
 * PENDING_PAYMENT is absent: nothing was taken, so there is nothing to ask for
 * back. COMPLETED is present because a print that technically finished can
 * still come out blank or smudged, which is the single most common reason
 * anyone asks.
 */
export const REQUESTABLE_ORDER_STATUSES = [
  "PAID",
  "READY",
  "PRINTING",
  "FAILED",
  "COMPLETED",
] as const;

/**
 * How long after an order a refund can be asked for. Short on purpose: the
 * evidence is the machine and the paper, and neither is checkable a month
 * later. Long enough that someone who printed on a Friday can still ask on
 * Monday.
 */
export const REQUEST_WINDOW_DAYS = 7;

/**
 * How long a shop has to answer before staff can step in. Not enforced as an
 * auto-approval — a shop that is simply closed for the weekend should not lose
 * by default — but it is what the platform's queue sorts on.
 */
export const VENDOR_SLA_HOURS = 48;

export const MIN_DESCRIPTION = 10;
export const MAX_DESCRIPTION = 1500;
export const MAX_NOTE = 1000;

export const createRequestSchema = z.object({
  reason: z.enum(REQUESTABLE_REASONS),
  description: z
    .string()
    .trim()
    .min(MIN_DESCRIPTION, `Please describe what happened in at least ${MIN_DESCRIPTION} characters.`)
    .max(MAX_DESCRIPTION),
});

export const decisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(MAX_NOTE).optional(),
});

export const escalateSchema = z.object({
  note: z
    .string()
    .trim()
    .min(MIN_DESCRIPTION, "Tell us why you think this decision was wrong.")
    .max(MAX_DESCRIPTION),
});

export const staffDecisionSchema = z.object({
  decision: z.enum(["APPROVE", "REJECT"]),
  note: z.string().trim().max(MAX_NOTE).optional(),
});

export type CreateRequestInput = z.infer<typeof createRequestSchema>;
export type DecisionInput = z.infer<typeof decisionSchema>;

/** Statuses the customer can still withdraw from. */
export const WITHDRAWABLE: readonly RefundRequestStatus[] = ["PENDING", "REJECTED"];

/** Statuses that mean nobody is waiting on anything. */
export const CLOSED: readonly RefundRequestStatus[] = [
  "APPROVED",
  "ESCALATION_APPROVED",
  "ESCALATION_REJECTED",
  "CANCELLED",
];

/** Fields any party to a request may see. */
export const REQUEST_SELECT = {
  id: true,
  code: true,
  orderId: true,
  userId: true,
  vendorId: true,
  reason: true,
  description: true,
  status: true,
  decisionNote: true,
  decidedAt: true,
  escalatedAt: true,
  escalationNote: true,
  staffNote: true,
  resolvedAt: true,
  refundId: true,
  createdAt: true,
  updatedAt: true,
  order: {
    select: {
      id: true,
      orderCode: true,
      status: true,
      costPaise: true,
      pagesToPrint: true,
      createdAt: true,
      document: { select: { fileName: true } },
      printer: { select: { id: true, name: true, uniquePrinterId: true, locationName: true } },
    },
  },
  user: { select: { id: true, name: true, email: true, phone: true } },
  vendor: { select: { id: true, shopName: true } },
} as const;
