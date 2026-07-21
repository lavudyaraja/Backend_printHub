// Shapes and validation for two-way order ratings.
//
// The tag lists are plain arrays rather than reads off the Prisma enum for the
// same reason the complaint categories are: a request has to be validated
// before the database is touched, and the order the tags appear in here is the
// order they appear on every screen.
import { z } from "zod";

export const RATING_DIRECTIONS = ["USER_TO_VENDOR", "VENDOR_TO_USER"] as const;
export type RatingDirection = (typeof RATING_DIRECTIONS)[number];

/** Tags a student may put on a shop. */
export const VENDOR_TAGS = [
  "PRINT_QUALITY",
  "FAST_SERVICE",
  "CLEAN_SHOP",
  "HELPFUL_STAFF",
  "FAIR_PRICING",
  "SLOW_SERVICE",
  "RUDE_STAFF",
  "MACHINE_ISSUES",
  "OVERCHARGED",
] as const;

/** Tags a shop may put on a student. */
export const USER_TAGS = [
  "POLITE",
  "ON_TIME_PICKUP",
  "CLEAR_INSTRUCTIONS",
  "NO_SHOW",
  "RUDE_BEHAVIOUR",
  "MISUSED_MACHINE",
  "WASTED_PAPER",
] as const;

export type RatingTag = (typeof VENDOR_TAGS)[number] | (typeof USER_TAGS)[number];

export const TAG_LABELS: Record<RatingTag, string> = {
  // student → shop
  PRINT_QUALITY: "Good print quality",
  FAST_SERVICE: "Fast service",
  CLEAN_SHOP: "Clean shop",
  HELPFUL_STAFF: "Helpful staff",
  FAIR_PRICING: "Fair pricing",
  SLOW_SERVICE: "Slow service",
  RUDE_STAFF: "Rude staff",
  MACHINE_ISSUES: "Machine problems",
  OVERCHARGED: "Overcharged",
  // shop → student
  POLITE: "Polite",
  ON_TIME_PICKUP: "Collected on time",
  CLEAR_INSTRUCTIONS: "Clear instructions",
  NO_SHOW: "Never collected",
  RUDE_BEHAVIOUR: "Rude behaviour",
  MISUSED_MACHINE: "Misused the machine",
  WASTED_PAPER: "Wasted paper",
};

/**
 * Tags that read as a complaint. They don't change the score — the stars do
 * that — but the moderation queue surfaces them first, because a "never
 * collected" or "overcharged" is the kind of thing staff want to see the day it
 * lands rather than in a monthly report.
 */
export const NEGATIVE_TAGS: readonly RatingTag[] = [
  "SLOW_SERVICE",
  "RUDE_STAFF",
  "MACHINE_ISSUES",
  "OVERCHARGED",
  "NO_SHOW",
  "RUDE_BEHAVIOUR",
  "MISUSED_MACHINE",
  "WASTED_PAPER",
];

/** Which tags belong to which direction. Used to reject mismatched requests. */
export const TAGS_BY_DIRECTION: Record<RatingDirection, readonly RatingTag[]> = {
  USER_TO_VENDOR: VENDOR_TAGS,
  VENDOR_TO_USER: USER_TAGS,
};

/** At most this many tags on one rating, and this much text. */
export const MAX_TAGS = 4;
export const MAX_COMMENT_LENGTH = 1000;

/**
 * How long after an order completes a rating can still be left. Feedback about
 * a print from four months ago tells nobody anything useful, and a shop that
 * has since changed hands shouldn't inherit it. Long enough that a student who
 * only opens the app at exam time still gets to say something.
 */
export const RATING_WINDOW_DAYS = 30;

const tagsField = z
  .array(z.string())
  .max(MAX_TAGS, `Pick at most ${MAX_TAGS} tags.`)
  .optional()
  .default([]);

export const submitRatingSchema = z.object({
  stars: z.coerce
    .number()
    .int("Give a whole number of stars.")
    .min(1, "Give at least one star.")
    .max(5, "Five stars is the highest."),
  comment: z.string().trim().max(MAX_COMMENT_LENGTH).optional(),
  tags: tagsField,
});

export type SubmitRatingInput = z.infer<typeof submitRatingSchema>;

/**
 * Drop tags that don't belong to this direction rather than rejecting the whole
 * submission. An app one version behind may still send a tag that has since
 * moved or been renamed, and losing a five-star rating over a stale chip is a
 * worse outcome than recording it without that chip.
 */
export function sanitizeTags(direction: RatingDirection, tags: string[]): RatingTag[] {
  const allowed = TAGS_BY_DIRECTION[direction] as readonly string[];
  const seen = new Set<string>();
  const out: RatingTag[] = [];
  for (const tag of tags) {
    const value = tag?.trim().toUpperCase();
    if (!value || seen.has(value) || !allowed.includes(value)) continue;
    seen.add(value);
    out.push(value as RatingTag);
    if (out.length >= MAX_TAGS) break;
  }
  return out;
}

/** The catalog both clients render from, so nobody hardcodes a tag list. */
export function tagCatalog(direction: RatingDirection) {
  return TAGS_BY_DIRECTION[direction].map((value) => ({
    value,
    label: TAG_LABELS[value],
    negative: NEGATIVE_TAGS.includes(value),
  }));
}

/** Fields any caller may see. Never exposes the moderation note. */
export const RATING_SELECT = {
  id: true,
  direction: true,
  stars: true,
  comment: true,
  tags: true,
  status: true,
  createdAt: true,
  updatedAt: true,
  orderId: true,
  userId: true,
  vendorId: true,
  authorId: true,
  order: { select: { id: true, orderCode: true, createdAt: true } },
  user: { select: { id: true, name: true } },
  vendor: { select: { id: true, shopName: true } },
} as const;

/** The moderation view: everything above, plus who hid it and why. */
export const RATING_ADMIN_SELECT = {
  ...RATING_SELECT,
  hiddenReason: true,
  hiddenById: true,
  hiddenAt: true,
  author: { select: { id: true, name: true, email: true, role: true } },
} as const;

/** A star histogram, so a 4.0 from ten fives and ten ones reads honestly. */
export interface RatingSummary {
  average: number;
  count: number;
  breakdown: Record<1 | 2 | 3 | 4 | 5, number>;
}

export const EMPTY_SUMMARY: RatingSummary = {
  average: 0,
  count: 0,
  breakdown: { 1: 0, 2: 0, 3: 0, 4: 0, 5: 0 },
};
