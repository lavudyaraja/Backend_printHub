// Referral API, scoped to the signed-in account.
import { Router } from "express";
import { z } from "zod";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { applyReferralCode, getReferralSummary } from "./service";

export const referralsRouter = Router();

/** This account's code, its invitees, and what they've earned. */
referralsRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const summary = await getReferralSummary(req.user!.userId);
  res.json(summary);
});

const applySchema = z.object({ code: z.string().min(1, "Enter a referral code") });

/** Redeem a friend's code. */
referralsRouter.post("/apply", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = applySchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Enter a referral code" });
  }

  const result = await applyReferralCode(req.user!.userId, parsed.data.code);
  if (!result.ok) return res.status(result.status).json({ error: result.error });

  res.json({
    ok: true,
    referrerName: result.referrerName,
    // The points land when the first print completes, not now — say so, or the
    // user goes looking for a balance that hasn't moved.
    message: `Code applied. You'll both earn points once your first print completes.`,
  });
});
