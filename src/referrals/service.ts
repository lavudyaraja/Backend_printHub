/**
 * Referrals: issuing codes, accepting them, and paying the reward.
 *
 * The reward is deliberately not paid at sign-up. Both sides are credited when
 * the invited user's *first order completes* — a scheme that pays on account
 * creation is free points for anyone willing to make throwaway accounts.
 */
import { Prisma } from "@prisma/client";
import { prisma } from "../lib/prisma";
import {
  CODE_ALPHABET,
  CODE_LENGTH,
  REFEREE_REWARD_POINTS,
  REFERRER_REWARD_POINTS,
  normaliseCode,
} from "./types";

function randomCode(): string {
  let out = "";
  for (let i = 0; i < CODE_LENGTH; i++) {
    out += CODE_ALPHABET[Math.floor(Math.random() * CODE_ALPHABET.length)];
  }
  return out;
}

/**
 * This account's code, generating one the first time it's asked for.
 *
 * Retries on collision rather than trusting a single draw: the alphabet is
 * deliberately small (confusable characters removed), so collisions are likelier
 * than the raw keyspace suggests.
 */
export async function getOrCreateReferralCode(userId: string): Promise<string> {
  const existing = await prisma.user.findUnique({
    where: { id: userId },
    select: { referralCode: true },
  });
  if (existing?.referralCode) return existing.referralCode;

  for (let attempt = 0; attempt < 6; attempt++) {
    const code = randomCode();
    try {
      const updated = await prisma.user.update({
        where: { id: userId },
        data: { referralCode: code },
        select: { referralCode: true },
      });
      return updated.referralCode!;
    } catch (e) {
      // Unique violation — another account already holds this code. Draw again.
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") continue;
      throw e;
    }
  }
  throw new Error("Could not allocate a referral code. Please try again.");
}

export type ApplyResult =
  | { ok: true; referrerName: string }
  | { ok: false; error: string; status: number };

/**
 * Accept someone else's code.
 *
 * Rejected when: the code is unknown, it's the caller's own, the caller already
 * used one, or the caller has already ordered. That last rule is what keeps the
 * scheme about bringing in *new* users rather than rewarding existing ones who
 * swap codes with each other.
 */
export async function applyReferralCode(userId: string, rawCode: string): Promise<ApplyResult> {
  const code = normaliseCode(rawCode);
  if (code.length !== CODE_LENGTH) {
    return { ok: false, error: `A referral code is ${CODE_LENGTH} characters.`, status: 400 };
  }

  const me = await prisma.user.findUnique({
    where: { id: userId },
    select: { referredById: true, referralCode: true, _count: { select: { orders: true } } },
  });
  if (!me) return { ok: false, error: "Account not found.", status: 404 };

  if (me.referredById) {
    return { ok: false, error: "You've already used a referral code.", status: 409 };
  }
  if (me.referralCode && normaliseCode(me.referralCode) === code) {
    return { ok: false, error: "That's your own code — share it with a friend instead.", status: 400 };
  }
  if (me._count.orders > 0) {
    return {
      ok: false,
      error: "Referral codes can only be applied before your first order.",
      status: 409,
    };
  }

  const referrer = await prisma.user.findUnique({
    where: { referralCode: code },
    select: { id: true, name: true },
  });
  if (!referrer) return { ok: false, error: "That referral code doesn't exist.", status: 404 };
  if (referrer.id === userId) {
    return { ok: false, error: "That's your own code — share it with a friend instead.", status: 400 };
  }

  await prisma.user.update({ where: { id: userId }, data: { referredById: referrer.id } });
  return { ok: true, referrerName: referrer.name };
}

/**
 * Pay both sides, once, after the invited user's first order completes.
 *
 * Never throws: this hangs off an order status update, and a reward that failed
 * must not roll back the completion that triggered it. `referralRewardedAt` is
 * the guard — orders complete many times over an account's life, and only the
 * first one earns.
 */
export async function maybePayReferralReward(userId: string): Promise<void> {
  try {
    const user = await prisma.user.findUnique({
      where: { id: userId },
      select: { id: true, name: true, referredById: true, referralRewardedAt: true },
    });
    if (!user?.referredById || user.referralRewardedAt) return;

    await prisma.$transaction(async (tx) => {
      // Claim the payout first. If a concurrent completion is doing the same,
      // one of the two updates matches zero rows and that side stops here
      // rather than crediting a second time.
      const claimed = await tx.user.updateMany({
        where: { id: user.id, referralRewardedAt: null },
        data: { referralRewardedAt: new Date() },
      });
      if (claimed.count === 0) return;

      const referrerId = user.referredById!;

      const referee = await tx.user.update({
        where: { id: user.id },
        data: { pointsBalance: { increment: REFEREE_REWARD_POINTS } },
        select: { pointsBalance: true },
      });
      await tx.pointsTransaction.create({
        data: {
          userId: user.id,
          type: "CREDIT",
          amountPoints: REFEREE_REWARD_POINTS,
          balancePoints: referee.pointsBalance,
          description: "Referral bonus — welcome to Prinsta",
        },
      });
      await tx.notification.create({
        data: {
          userId: user.id,
          title: "Referral bonus added",
          body: `${REFEREE_REWARD_POINTS} points have been added to your balance for joining through a friend's code.`,
        },
      });

      const referrer = await tx.user.update({
        where: { id: referrerId },
        data: { pointsBalance: { increment: REFERRER_REWARD_POINTS } },
        select: { pointsBalance: true },
      });
      await tx.pointsTransaction.create({
        data: {
          userId: referrerId,
          type: "CREDIT",
          amountPoints: REFERRER_REWARD_POINTS,
          balancePoints: referrer.pointsBalance,
          description: `Referral reward — ${user.name} made their first print`,
        },
      });
      await tx.notification.create({
        data: {
          userId: referrerId,
          title: "Referral reward earned",
          body: `${user.name} made their first print. ${REFERRER_REWARD_POINTS} points are yours.`,
        },
      });
    });
  } catch (e) {
    console.error(`[referrals] reward payout failed for ${userId}:`, e);
  }
}

/** Everything the referrals screen needs, in one round trip. */
export async function getReferralSummary(userId: string) {
  const code = await getOrCreateReferralCode(userId);

  const [invitees, me] = await Promise.all([
    prisma.user.findMany({
      where: { referredById: userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, name: true, createdAt: true, referralRewardedAt: true },
    }),
    prisma.user.findUnique({
      where: { id: userId },
      select: {
        referredById: true,
        referralRewardedAt: true,
        _count: { select: { orders: true } },
      },
    }),
  ]);

  const earned = invitees.filter((i) => i.referralRewardedAt).length;

  return {
    code,
    invited: invitees.length,
    // Only rewarded invitees have actually paid out; the rest are still pending
    // their first print.
    rewarded: earned,
    pending: invitees.length - earned,
    pointsEarned: earned * REFERRER_REWARD_POINTS,
    referrerPoints: REFERRER_REWARD_POINTS,
    refereePoints: REFEREE_REWARD_POINTS,
    /** Whether this account can still redeem someone else's code. */
    canApplyCode: !me?.referredById && (me?._count.orders ?? 0) === 0,
    hasUsedCode: !!me?.referredById,
    invitees: invitees.map((i) => ({
      id: i.id,
      name: i.name,
      joinedAt: i.createdAt,
      rewarded: !!i.referralRewardedAt,
    })),
  };
}
