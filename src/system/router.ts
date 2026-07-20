// System: notifications, logs, security and settings.
//
// ADMIN only. Three of these four sections are mostly *not* backed by tables —
// there is no push transport, no SMS gateway, no audit trail and no session
// store. Only what genuinely exists is exposed here; the console names the rest
// as missing rather than rendering an empty list that reads as "all clear".
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";

export const systemRouter = Router();
systemRouter.use(requireAuth, requireRole("ADMIN"));

// ── Notifications ────────────────────────────────────────────────────────────
// In-app only. `Notification` rows are what the mobile app's bell reads; there
// is no push token, SMS gateway or template table anywhere in the platform.
systemRouter.get("/notifications", async (_req, res) => {
  const since = new Date(Date.now() - 30 * 86400000);

  const [total, unread, recent, last30, byUser] = await Promise.all([
    prisma.notification.count(),
    prisma.notification.count({ where: { read: false } }),
    prisma.notification.findMany({
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, title: true, body: true, read: true, orderId: true, createdAt: true,
        user: { select: { id: true, name: true, role: true } },
      },
    }),
    prisma.notification.count({ where: { createdAt: { gte: since } } }),
    prisma.notification.groupBy({ by: ["userId"], _count: { _all: true }, orderBy: { _count: { userId: "desc" } }, take: 1 }),
  ]);

  res.json({
    total,
    unread,
    read: total - unread,
    last30Days: last30,
    /** How many distinct people have ever been notified. */
    reachedUsers: byUser.length > 0 ? await prisma.notification.findMany({ distinct: ["userId"], select: { userId: true } }).then((r) => r.length) : 0,
    recent,
    // What the platform can actually deliver on, stated rather than implied.
    channels: {
      inApp: { available: true, note: "Notification rows, read by the app's bell." },
      email: { available: true, note: "Transactional email via the mailer — order and login mails only, not broadcastable." },
      push: { available: false, note: "No device tokens are stored and no push service is configured." },
      sms: { available: false, note: "No SMS gateway is configured." },
    },
  });
});

const broadcastSchema = z.object({
  title: z.string().trim().min(3, "Give the notification a title").max(120),
  body: z.string().trim().min(3, "Write the message").max(1000),
  audience: z.enum(["ALL", "STUDENT", "VENDOR", "ADMIN"]),
});

/**
 * Send an in-app notification to a segment.
 *
 * Real delivery, to real people — so it is capped and reports exactly how many
 * rows it wrote. Banned accounts are skipped: they can't sign in to read it.
 */
systemRouter.post("/notifications/broadcast", async (req: AuthedRequest, res) => {
  const parsed = broadcastSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid message" });
  }
  const { title, body, audience } = parsed.data;

  const where: any = { bannedAt: null };
  if (audience === "STUDENT") where.role = "STUDENT";
  if (audience === "VENDOR") where.role = { in: ["VENDOR", "OPERATOR"] };
  if (audience === "ADMIN") where.role = "ADMIN";

  const recipients = await prisma.user.findMany({ where, select: { id: true } });
  if (recipients.length === 0) {
    return res.status(409).json({ error: "That audience has no active accounts." });
  }

  const created = await prisma.notification.createMany({
    data: recipients.map((u) => ({ userId: u.id, title, body })),
  });

  res.status(201).json({ sent: created.count, audience, recipients: recipients.length });
});

// ── Logs ─────────────────────────────────────────────────────────────────────
// Nothing writes an audit trail, so these are reconstructions from records that
// happen to carry a timestamp. They show what *users* did, never what staff did.
systemRouter.get("/logs", async (req, res) => {
  const { kind = "payment" } = req.query as Record<string, string>;

  if (kind === "payment") {
    const [txns, orders] = await Promise.all([
      prisma.pointsTransaction.findMany({
        orderBy: { createdAt: "desc" },
        take: 150,
        select: {
          id: true, type: true, amountPoints: true, amountPaise: true, balancePoints: true,
          balancePaise: true, description: true, razorpayId: true, orderId: true, createdAt: true,
          user: { select: { id: true, name: true } },
        },
      }),
      prisma.order.findMany({
        where: { OR: [{ razorpayOrderId: { not: null } }, { razorpayPaymentId: { not: null } }] },
        orderBy: { createdAt: "desc" },
        take: 150,
        select: {
          id: true, orderCode: true, status: true, costPaise: true, paymentMethod: true,
          razorpayOrderId: true, razorpayPaymentId: true, createdAt: true,
          user: { select: { id: true, name: true } },
        },
      }),
    ]);
    return res.json({ kind, ledger: txns, gateway: orders });
  }

  if (kind === "printer") {
    const jobs = await prisma.printJob.findMany({
      orderBy: { updatedAt: "desc" },
      take: 200,
      select: {
        id: true, status: true, attempts: true, error: true,
        startedAt: true, finishedAt: true, createdAt: true, updatedAt: true,
        printer: { select: { id: true, name: true, uniquePrinterId: true } },
        order: { select: { orderCode: true } },
      },
    });
    return res.json({ kind, jobs, errors: jobs.filter((j) => j.status === "ERROR") });
  }

  if (kind === "user" || kind === "vendor") {
    // Reconstructed from orders — the only per-actor record with a timestamp.
    const where = kind === "vendor" ? { vendorId: { not: null } } : {};
    const orders = await prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, orderCode: true, status: true, costPaise: true, createdAt: true,
        user: { select: { id: true, name: true, role: true } },
        vendor: { select: { id: true, shopName: true } },
        printer: { select: { name: true, uniquePrinterId: true } },
      },
    });
    return res.json({ kind, orders });
  }

  res.status(400).json({ error: "Unknown log kind" });
});

// ── Security ─────────────────────────────────────────────────────────────────
systemRouter.get("/security", async (_req, res) => {
  const [byRole, accounts, banned, withPassword, googleOnly] = await Promise.all([
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    prisma.user.findMany({
      orderBy: { createdAt: "desc" },
      take: 300,
      select: {
        id: true, name: true, email: true, phone: true, role: true,
        createdAt: true, updatedAt: true, bannedAt: true, banReason: true,
        loginAlertSent: true, googleId: true, passwordHash: true,
        vendor: { select: { id: true, shopName: true } },
      },
    }),
    prisma.user.count({ where: { bannedAt: { not: null } } }),
    prisma.user.count({ where: { passwordHash: { not: null } } }),
    prisma.user.count({ where: { googleId: { not: null }, passwordHash: null } }),
  ]);

  const roleCount = (r: string) => byRole.find((x) => x.role === r)?._count._all ?? 0;

  res.json({
    admins: roleCount("ADMIN"),
    vendors: roleCount("VENDOR") + roleCount("OPERATOR"),
    students: roleCount("STUDENT"),
    banned,
    passwordAccounts: withPassword,
    googleOnlyAccounts: googleOnly,
    accounts: accounts.map(({ passwordHash, googleId, ...a }) => ({
      ...a,
      // Never leak the hash; the console only needs to know how they sign in.
      authMethod: passwordHash ? (googleId ? "Password + Google" : "Password") : googleId ? "Google" : "None",
    })),
  });
});

const banSchema = z.object({
  banned: z.boolean(),
  reason: z.string().trim().max(500).optional(),
});

/** Ban or unban an account. Blocks sign-in; the balance is left untouched. */
systemRouter.patch("/security/accounts/:id/ban", async (req: AuthedRequest, res) => {
  const parsed = banSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid request" });

  if (req.params.id === req.user!.userId) {
    // Locking yourself out of the console you administer helps nobody.
    return res.status(409).json({ error: "You can't ban your own account." });
  }

  const target = await prisma.user.findUnique({ where: { id: req.params.id }, select: { id: true, role: true } });
  if (!target) return res.status(404).json({ error: "Account not found" });

  const user = await prisma.user.update({
    where: { id: target.id },
    data: parsed.data.banned
      ? { bannedAt: new Date(), banReason: parsed.data.reason || null, bannedById: req.user!.userId }
      : { bannedAt: null, banReason: null, bannedById: null },
    select: { id: true, name: true, bannedAt: true, banReason: true },
  });

  res.json({ user });
});
