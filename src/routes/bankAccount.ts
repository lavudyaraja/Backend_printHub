// Payout bank account, for whoever is signed in.
//
// One account per user. These routes lived on the ADMIN-guarded admin router,
// which meant a shop owner could not enter the account their own payouts go to —
// nothing in them is admin-specific, every query is already scoped to
// req.user.userId. They are console-only (vendor or admin), not open to the
// student app, which has no payouts to receive.
//
// Responses never include the full account number, only the last four digits,
// so a leaked response can't be used to move money.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";
import { isAdminRole, isVendorRole } from "../lib/vendorScope";

export const bankAccountRouter = Router();

bankAccountRouter.use(requireAuth, (req: AuthedRequest, res, next) => {
  if (!isVendorRole(req.user?.role) && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ error: "This is a console-only action." });
  }
  next();
});

const IFSC = /^[A-Z]{4}0[A-Z0-9]{6}$/;
const ACCOUNT_NO = /^\d{6,18}$/;

const bankSchema = z.object({
  accountHolder: z.string().trim().min(2, "Enter the account holder's name").max(120),
  accountNumber: z.string().trim().regex(ACCOUNT_NO, "Account number must be 6–18 digits"),
  ifsc: z
    .string()
    .trim()
    .transform((v) => v.toUpperCase())
    .refine((v) => IFSC.test(v), "Enter a valid IFSC code (e.g. HDFC0001234)"),
  bankName: z.string().trim().max(120).optional().or(z.literal("")),
  branch: z.string().trim().max(120).optional().or(z.literal("")),
  upiId: z
    .string()
    .trim()
    .max(120)
    .optional()
    .or(z.literal(""))
    .refine((v) => !v || /^[\w.\-]{2,}@[a-zA-Z]{2,}$/.test(v), "Enter a valid UPI ID (e.g. name@bank)"),
});

/** Shape returned to the client — masked, never the full number. */
function publicAccount(a: {
  accountHolder: string; accountNumber: string; ifsc: string;
  bankName: string | null; branch: string | null; upiId: string | null;
  verified: boolean; updatedAt: Date;
}) {
  return {
    accountHolder: a.accountHolder,
    accountLast4: a.accountNumber.slice(-4),
    accountMasked: `••••••${a.accountNumber.slice(-4)}`,
    ifsc: a.ifsc,
    bankName: a.bankName,
    branch: a.branch,
    upiId: a.upiId,
    verified: a.verified,
    updatedAt: a.updatedAt,
  };
}

bankAccountRouter.get("/", async (req: AuthedRequest, res) => {
  const account = await prisma.bankAccount.findUnique({ where: { userId: req.user!.userId } });
  res.json({ account: account ? publicAccount(account) : null });
});

bankAccountRouter.put("/", async (req: AuthedRequest, res) => {
  const parsed = bankSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid bank details" });
  }
  const d = parsed.data;
  const data = {
    accountHolder: d.accountHolder,
    accountNumber: d.accountNumber,
    ifsc: d.ifsc,
    bankName: d.bankName || null,
    branch: d.branch || null,
    upiId: d.upiId || null,
    // Any change invalidates a previous verification.
    verified: false,
  };

  const account = await prisma.bankAccount.upsert({
    where: { userId: req.user!.userId },
    create: { userId: req.user!.userId, ...data },
    update: data,
  });
  res.json({ account: publicAccount(account) });
});

bankAccountRouter.delete("/", async (req: AuthedRequest, res) => {
  await prisma.bankAccount.deleteMany({ where: { userId: req.user!.userId } });
  res.json({ ok: true });
});
