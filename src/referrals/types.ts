/**
 * Referral rewards.
 *
 * Both sides are paid at the same moment: when the invited user's first order
 * actually completes. Paying on sign-up instead would make the scheme free money
 * for anyone willing to create throwaway accounts — the reward has to be tied to
 * something that costs effort and produces a real print.
 */

/** Points the inviter earns, once, per friend who completes a first print. */
export const REFERRER_REWARD_POINTS = 100;

/** Points the invited user earns when their first print completes. */
export const REFEREE_REWARD_POINTS = 50;

/**
 * Referral codes are read aloud and typed by hand, so the alphabet leaves out
 * the characters people confuse: O/0, I/1/L, S/5, B/8.
 */
export const CODE_ALPHABET = "ACDEFGHJKMNPQRTUVWXY2346789";
export const CODE_LENGTH = 6;

/** Codes are stored and compared uppercase; input is normalised to match. */
export function normaliseCode(raw: string): string {
  return (raw || "").trim().toUpperCase().replace(/[^A-Z0-9]/g, "");
}
