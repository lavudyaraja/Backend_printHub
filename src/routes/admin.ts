// Prinsta Admin API: stats, revenue, orders, users, support tickets, settings
import { Router } from "express";
import { z } from "zod";
import bcrypt from "bcryptjs";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";
import { readSettings, writeSettings, maskSecrets } from "../lib/settings";
import { pointsToPaise } from "../lib/points";
import { REFERRER_REWARD_POINTS, REFEREE_REWARD_POINTS } from "../referrals/types";
import { adminRatingStats, listRatingsForAdmin, setRatingVisibility, summarize } from "../ratings/service";
import { RATING_ADMIN_SELECT } from "../ratings/types";
import { refundComplaint } from "../complaints/service";

export const adminRouter = Router();
adminRouter.use(requireAuth, requireRole("ADMIN"));

const LOW_PAPER = 20;

// ── Dashboard metrics ──────────────────────────────────────────────────────────
adminRouter.get("/metrics", async (_req, res) => {
  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [
    totalOrders, completedOrders, failedOrders, cancelledOrders,
    dailyOrders, monthlyOrders, lastMonthOrders,
    totalUsers, newUsersToday,
    revenueAll, revenueMonth, revenueLastMonth,
    pagesAll, printers,
    pointsStats,
    ordersByPrinter, revenueByPrinter,
    usersByRole, vendorProfiles, bankAccounts, verifiedBankAccounts,
  ] = await Promise.all([
    prisma.order.count(),
    prisma.order.count({ where: { status: "COMPLETED" } }),
    prisma.order.count({ where: { status: "FAILED" } }),
    prisma.order.count({ where: { status: "CANCELLED" } }),
    prisma.order.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.order.count({ where: { createdAt: { gte: startOfMonth } } }),
    prisma.order.count({ where: { createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.user.count({ where: { role: "STUDENT" } }),
    prisma.user.count({ where: { createdAt: { gte: startOfDay } } }),
    prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED" } }),
    prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED", createdAt: { gte: startOfMonth } } }),
    prisma.order.aggregate({ _sum: { costPaise: true }, where: { status: "COMPLETED", createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
    prisma.order.aggregate({ _sum: { pagesToPrint: true }, where: { status: "COMPLETED" } }),
    prisma.printer.findMany({ select: { id: true, name: true, shopName: true, locationName: true, uniquePrinterId: true, status: true, paperLevel: true, tonerLevel: true } }),
    prisma.pointsTransaction.aggregate({ _sum: { amountPoints: true }, where: { type: "CREDIT" } }),
    // Per-printer workload. Grouped in the database rather than counted from a
    // page of orders on the client, so the figures cover every order and not
    // just whichever ones the current filter happened to load.
    prisma.order.groupBy({ by: ["printerId"], _count: { _all: true } }),
    prisma.order.groupBy({
      by: ["printerId"],
      _sum: { costPaise: true, pagesToPrint: true },
      where: { status: "COMPLETED" },
    }),
    // Head count by role, in one query rather than four.
    prisma.user.groupBy({ by: ["role"], _count: { _all: true } }),
    prisma.vendor.count(),
    prisma.bankAccount.count(),
    prisma.bankAccount.count({ where: { verified: true } }),
  ]);

  const thisMonthRevenue = revenueMonth._sum.costPaise || 0;
  const lastMonthRevenue = revenueLastMonth._sum.costPaise || 0;
  const revenueGrowth = lastMonthRevenue === 0 ? 100 : Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100);

  const orderGrowth = lastMonthOrders === 0 ? 100 : Math.round(((monthlyOrders - lastMonthOrders) / lastMonthOrders) * 100);

  // Join the two groupBys onto the printer list. Orders whose printerId is null
  // are real — a job can be placed before a printer is assigned — so they are
  // reported under their own entry rather than dropped from the totals.
  const orderCountFor = new Map(ordersByPrinter.map((r) => [r.printerId, r._count._all]));
  const revenueFor = new Map(revenueByPrinter.map((r) => [r.printerId, r._sum]));

  const printerBreakdown = printers.map((p) => ({
    id: p.id,
    name: p.name,
    shopName: p.shopName,
    locationName: p.locationName,
    uniquePrinterId: p.uniquePrinterId,
    // Widened: the synthetic "Unassigned" row below is not a real PrinterStatus.
    status: p.status as string,
    orders: orderCountFor.get(p.id) || 0,
    revenuePaise: revenueFor.get(p.id)?.costPaise || 0,
    pagesPrinted: revenueFor.get(p.id)?.pagesToPrint || 0,
  }));

  const unassignedOrders = orderCountFor.get(null) || 0;
  if (unassignedOrders > 0) {
    printerBreakdown.push({
      id: "unassigned",
      name: "Unassigned",
      shopName: "",
      locationName: "",
      uniquePrinterId: "",
      status: "NONE",
      orders: unassignedOrders,
      revenuePaise: revenueFor.get(null)?.costPaise || 0,
      pagesPrinted: revenueFor.get(null)?.pagesToPrint || 0,
    });
  }

  printerBreakdown.sort((a, b) => b.orders - a.orders);

  const roleCount = (r: string) => usersByRole.find((x) => x.role === r)?._count._all ?? 0;
  const studentCount = roleCount("STUDENT");
  const vendorCount = roleCount("VENDOR") + roleCount("OPERATOR");
  const adminCount = roleCount("ADMIN");

  res.json({
    printerBreakdown,
    totalOrders,
    completedOrders,
    failedOrders,
    cancelledOrders,
    dailyOrders,
    monthlyOrders,
    orderGrowth,
    // Kept under its original name: it has always meant "students", and the
    // dashboard reads it. The explicit breakdown below is the one to prefer.
    totalUsers,
    newUsersToday,
    studentCount,
    // VENDOR and OPERATOR are the same role under two names — see the Role enum.
    vendorCount,
    adminCount,
    /** Everyone with an account, whatever their role. */
    allUsersCount: studentCount + vendorCount + adminCount,
    /** Shops that have completed a vendor profile. */
    vendorProfiles,
    bankAccounts,
    verifiedBankAccounts,
    totalRevenuePaise: revenueAll._sum.costPaise || 0,
    monthlyRevenuePaise: thisMonthRevenue,
    revenueGrowth,
    totalPagesPrinted: pagesAll._sum.pagesToPrint || 0,
    totalPrinters: printers.length,
    activePrinters: printers.filter((p) => p.status === "ONLINE").length,
    offlinePrinters: printers.filter((p) => p.status === "OFFLINE").length,
    lowPaperCount: printers.filter((p) => p.paperLevel <= LOW_PAPER).length,
    pointsToppedUp: pointsStats._sum.amountPoints || 0,
    pointsTopupPaise: pointsToPaise(pointsStats._sum.amountPoints || 0),
  });
});

// ── Revenue analytics (last 30 days by day) ───────────────────────────────────
adminRouter.get("/revenue", async (req, res) => {
  const { period = "30d" } = req.query as { period?: string };
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  // Get completed orders grouped by day
  const orders = await prisma.order.findMany({
    where: { status: "COMPLETED", createdAt: { gte: since } },
    select: { createdAt: true, costPaise: true, pagesToPrint: true, colorMode: true },
    orderBy: { createdAt: "asc" },
  });

  // Group by date
  const dayMap = new Map<string, { date: string; revenuePaise: number; orders: number; pages: number; bwOrders: number; colorOrders: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().split("T")[0];
    dayMap.set(key, { date: key, revenuePaise: 0, orders: 0, pages: 0, bwOrders: 0, colorOrders: 0 });
  }

  for (const o of orders) {
    const key = o.createdAt.toISOString().split("T")[0];
    const entry = dayMap.get(key);
    if (entry) {
      entry.revenuePaise += o.costPaise;
      entry.orders += 1;
      entry.pages += o.pagesToPrint;
      if (o.colorMode === "COLOR") entry.colorOrders += 1;
      else entry.bwOrders += 1;
    }
  }

  // Top printers by revenue
  const topPrinters = await prisma.order.groupBy({
    by: ["printerId"],
    where: { status: "COMPLETED", createdAt: { gte: since }, printerId: { not: null } },
    _sum: { costPaise: true },
    _count: { id: true },
    orderBy: { _sum: { costPaise: "desc" } },
    take: 5,
  });

  const printerIds = topPrinters.map((p) => p.printerId).filter(Boolean) as string[];
  const printerNames = await prisma.printer.findMany({
    where: { id: { in: printerIds } },
    select: { id: true, name: true, shopName: true },
  });
  const nameMap = Object.fromEntries(printerNames.map((p) => [p.id, `${p.name} (${p.shopName})`]));

  res.json({
    chartData: Array.from(dayMap.values()),
    topPrinters: topPrinters.map((p) => ({
      printerId: p.printerId,
      name: p.printerId ? nameMap[p.printerId] || "Unknown" : "Unassigned",
      revenuePaise: p._sum.costPaise || 0,
      orders: p._count.id,
    })),
  });
});

// ── Orders list ────────────────────────────────────────────────────────────────
adminRouter.get("/orders", async (req, res) => {
  const { status, search, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where: any = {};
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { orderCode: { contains: search, mode: "insensitive" } },
      { user: { name: { contains: search, mode: "insensitive" } } },
      { user: { phone: { contains: search } } },
    ];
  }

  const [orders, total] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: {
        user: { select: { name: true, phone: true, email: true } },
        document: { select: { fileName: true, pageCount: true } },
        printer: { select: { name: true, shopName: true, uniquePrinterId: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  res.json({ orders, total });
});

// ── Users list ─────────────────────────────────────────────────────────────────
adminRouter.get("/users", async (req, res) => {
  const { search, role, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where: any = {};
  if (role) where.role = role;
  if (search) {
    where.OR = [
      { name: { contains: search, mode: "insensitive" } },
      { phone: { contains: search } },
      { email: { contains: search, mode: "insensitive" } },
    ];
  }

  const [users, total] = await Promise.all([
    prisma.user.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      select: {
        id: true, name: true, phone: true, email: true,
        role: true, pointsBalance: true, createdAt: true,
        _count: { select: { orders: true } },
      },
    }),
    prisma.user.count({ where }),
  ]);

  res.json({ users, total });
});

// ── Points / transactions ──────────────────────────────────────────────────────
adminRouter.get("/transactions", async (req, res) => {
  const { type, search, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where: any = {};
  if (type) where.type = type;
  if (search) {
    where.OR = [
      { user: { name: { contains: search, mode: "insensitive" } } },
      { description: { contains: search, mode: "insensitive" } },
    ];
  }

  const [txns, total] = await Promise.all([
    prisma.pointsTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: { user: { select: { name: true, phone: true } } },
    }),
    prisma.pointsTransaction.count({ where }),
  ]);

  res.json({ transactions: txns, total });
});

// ── Printers with low-resource alerts ─────────────────────────────────────────
adminRouter.get("/kiosks", async (_req, res) => {
  // Usage is what turns a registration list into an operating picture: which
  // machines the app is actually printing on, and which have never been used
  // since the vendor registered them.
  const [printers, orderCounts, customerRows] = await Promise.all([
    prisma.printer.findMany({ orderBy: { shopName: "asc" } }),
    prisma.order.groupBy({ by: ["printerId"], _count: { _all: true } }),
    prisma.order.findMany({
      where: { printerId: { not: null } },
      select: { printerId: true, userId: true },
      distinct: ["printerId", "userId"],
    }),
  ]);

  const ordersFor = new Map(orderCounts.map((r) => [r.printerId, r._count._all]));
  // Distinct users per printer — one student printing forty times is one user.
  const customersFor = new Map<string, number>();
  for (const row of customerRows) {
    if (!row.printerId) continue;
    customersFor.set(row.printerId, (customersFor.get(row.printerId) || 0) + 1);
  }

  res.json({
    // accessPassword is the printer's Wi-Fi Direct join password. Spreading the
    // whole row put it in this response; it has no use in the console and only
    // ever belongs in the payload the app gets when a user scans the QR.
    kiosks: printers.map(({ accessPassword, ...p }) => ({
      ...p,
      needsPaper: p.paperLevel <= LOW_PAPER,
      needsToner: p.tonerLevel <= LOW_PAPER,
      orders: ordersFor.get(p.id) || 0,
      customers: customersFor.get(p.id) || 0,
    })),
  });
});

// ── Disputes (user complaints), for triage ───────────────────────────────────
// The user-facing complaints API is scoped to one account; this is the queue.
adminRouter.get("/disputes", async (req, res) => {
  const { status, category, search } = req.query as Record<string, string>;

  const where: any = {};
  if (status) where.status = status;
  if (category) where.category = category;
  if (search) {
    where.OR = [
      { code: { contains: search, mode: "insensitive" } },
      { subject: { contains: search, mode: "insensitive" } },
      { user: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [disputes, byStatus] = await Promise.all([
    prisma.complaint.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, code: true, category: true, subject: true, description: true,
        status: true, resolution: true, resolvedAt: true, createdAt: true,
        refundRequested: true, forwardedAt: true, forwardNote: true, refundId: true,
        user: { select: { id: true, name: true, phone: true, email: true } },
        vendor: { select: { id: true, shopName: true } },
        printer: { select: { name: true, uniquePrinterId: true, shopName: true } },
        order: { select: { id: true, orderCode: true, status: true, costPaise: true } },
        _count: { select: { photos: true } },
      },
    }),
    prisma.complaint.groupBy({ by: ["status"], _count: { _all: true } }),
  ]);

  const countFor = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  res.json({
    total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
    open: countFor("OPEN"),
    inReview: countFor("IN_REVIEW"),
    forwarded: countFor("FORWARDED"),
    resolved: countFor("RESOLVED"),
    refunded: countFor("REFUNDED"),
    rejected: countFor("REJECTED"),
    disputes,
  });
});

/**
 * Grant the refund an issue asked for. Admin-only, and the only place a
 * complaint-driven refund is issued — see complaints/service.ts. Credits the
 * customer's Points, marks the complaint REFUNDED, and notifies both the
 * customer and the shop.
 */
adminRouter.post("/disputes/:id/refund", async (req: AuthedRequest, res) => {
  const note = typeof req.body?.resolution === "string" ? req.body.resolution : undefined;
  const result = await refundComplaint(req.params.id, req.user!.userId, note);
  if (!result.ok) {
    if (result.reason === "NOT_FOUND") return res.status(404).json({ error: "Dispute not found" });
    if (result.reason === "NO_ORDER") {
      return res.status(409).json({ error: "This complaint isn't tied to an order, so there's nothing to refund." });
    }
    return res.status(409).json({ error: result.detail || "Could not issue the refund." });
  }
  res.json({ dispute: result.complaint, pointsCredited: result.pointsCredited });
});

/** Move a dispute along, with the reply the user will see. */
adminRouter.patch("/disputes/:id", async (req, res) => {
  const parsed = z
    .object({
      status: z.enum(["OPEN", "IN_REVIEW", "FORWARDED", "RESOLVED", "REJECTED"]).optional(),
      resolution: z.string().trim().max(2000).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update" });

  const existing = await prisma.complaint.findUnique({
    where: { id: req.params.id },
    select: { id: true, userId: true, code: true },
  });
  if (!existing) return res.status(404).json({ error: "Dispute not found" });

  const { status, resolution } = parsed.data;
  const closing = status === "RESOLVED" || status === "REJECTED";

  const dispute = await prisma.complaint.update({
    where: { id: existing.id },
    data: {
      ...(status ? { status } : {}),
      ...(resolution !== undefined ? { resolution } : {}),
      // Cleared on reopen, so the timestamp can't outlive the state it describes.
      ...(status ? { resolvedAt: closing ? new Date() : null } : {}),
    },
  });

  // Closing someone's report silently is how a queue loses their trust.
  if (closing) {
    await prisma.notification.create({
      data: {
        userId: existing.userId,
        title: status === "RESOLVED" ? "Your report was resolved" : "Update on your report",
        body: resolution?.trim() || `We've updated report ${existing.code}. Open the app for details.`,
      },
    });
  }

  res.json({ dispute });
});

// ── Refunds issued across the platform ───────────────────────────────────────
adminRouter.get("/refunds", async (_req, res) => {
  const [refunds, totals] = await Promise.all([
    prisma.refund.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, amountPaise: true, pointsCredited: true, reason: true,
        origin: true, note: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true, email: true } },
        order: { select: { id: true, orderCode: true, status: true } },
      },
    }),
    prisma.refund.aggregate({ _sum: { amountPaise: true, pointsCredited: true }, _count: { _all: true } }),
  ]);

  res.json({
    total: totals._count._all,
    totalPaise: totals._sum.amountPaise || 0,
    totalPoints: totals._sum.pointsCredited || 0,
    automatic: refunds.filter((r) => r.origin === "AUTOMATIC").length,
    manual: refunds.filter((r) => r.origin === "MANUAL").length,
    refunds,
  });
});

// ── One vendor, in full ──────────────────────────────────────────────────────
adminRouter.get("/vendors/:id", async (req, res) => {
  const vendorId = req.params.id;

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      id: true, shopName: true, contactName: true, mobileNumber: true,
      bannedAt: true, banReason: true, createdAt: true, updatedAt: true,
      user: {
        select: {
          id: true, name: true, email: true, phone: true, role: true, createdAt: true,
          bankAccount: {
            select: {
              accountHolder: true, accountNumber: true, ifsc: true, bankName: true,
              branch: true, upiId: true, verified: true, updatedAt: true,
            },
          },
        },
      },
      locations: {
        orderBy: { createdAt: "asc" },
        select: { id: true, name: true, address: true, createdAt: true, _count: { select: { printers: true } } },
      },
      printers: {
        orderBy: { createdAt: "asc" },
        select: {
          id: true, name: true, uniquePrinterId: true, brand: true, model: true,
          status: true, paperLevel: true, tonerLevel: true, locationName: true,
          costPerBWPagePaise: true, costPerColorPagePaise: true, createdAt: true, lastSeenAt: true,
        },
      },
    },
  });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  const [orders, revenue, byStatus, customers, ratingSummary, ratings] = await Promise.all([
    prisma.order.findMany({
      where: { vendorId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, orderCode: true, status: true, costPaise: true, pagesToPrint: true,
        colorMode: true, createdAt: true,
        user: { select: { id: true, name: true } },
        printer: { select: { name: true, uniquePrinterId: true } },
      },
    }),
    prisma.order.aggregate({
      _sum: { costPaise: true, pagesToPrint: true },
      where: { vendorId, status: "COMPLETED" },
    }),
    prisma.order.groupBy({ by: ["status"], where: { vendorId }, _count: { _all: true } }),
    prisma.order.findMany({ where: { vendorId }, select: { userId: true }, distinct: ["userId"] }),
    // Staff see hidden ratings too, so the moderation view here matches the
    // ratings queue rather than the shop's own console.
    summarize({ vendorId }),
    prisma.rating.findMany({
      where: { vendorId, direction: "USER_TO_VENDOR" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: RATING_ADMIN_SELECT,
    }),
  ]);

  const countFor = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;
  const totalOrders = byStatus.reduce((sum, r) => sum + r._count._all, 0);

  const activity = [
    ...orders.slice(0, 60).map((o) => ({
      at: o.createdAt,
      kind: "ORDER" as const,
      title: `Order ${o.orderCode} · ${o.status.replace(/_/g, " ").toLowerCase()}`,
      detail: `${o.user?.name || "A customer"} · ${o.printer?.name || "unassigned"}`,
    })),
    ...vendor.printers.map((p) => ({
      at: p.createdAt,
      kind: "PRINTER" as const,
      title: `Registered ${p.name}`,
      detail: `${p.uniquePrinterId} · ${p.locationName}`,
    })),
    { at: vendor.createdAt, kind: "JOINED" as const, title: "Shop registered", detail: vendor.shopName },
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 120);

  res.json({
    vendor,
    summary: {
      totalOrders,
      completedOrders: countFor("COMPLETED"),
      failedOrders: countFor("FAILED"),
      cancelledOrders: countFor("CANCELLED"),
      revenuePaise: revenue._sum.costPaise || 0,
      pagesPrinted: revenue._sum.pagesToPrint || 0,
      customers: customers.length,
      printers: vendor.printers.length,
      locations: vendor.locations.length,
    },
    orders,
    activity,
    ratingSummary,
    ratings,
  });
});

// ── One user, in full ────────────────────────────────────────────────────────
// Everything the operator console's user profile shows, in a single round trip.
// Two of the sections have no table behind them and are derived instead:
//   • "Saved printers" — the machines this user has actually printed on, which
//     is the useful version of the question. There is no favourites feature.
//   • "Activity" — a timeline stitched from real events (orders, points moves,
//     reports, refunds). It is not an audit log; nothing here records staff
//     actions, and it should not be read as if it did.
adminRouter.get("/users/:id", async (req, res) => {
  const userId = req.params.id;

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, phone: true, email: true, rollNumber: true, role: true,
      pointsBalance: true, emailNotifications: true, createdAt: true, updatedAt: true,
      referralCode: true, referredById: true, referralRewardedAt: true,
      bannedAt: true, banReason: true,
      referredBy: { select: { id: true, name: true, referralCode: true } },
      referrals: {
        orderBy: { createdAt: "desc" },
        select: { id: true, name: true, createdAt: true, referralRewardedAt: true },
      },
      _count: { select: { orders: true, complaints: true, refunds: true, documents: true } },
    },
  });
  if (!user) return res.status(404).json({ error: "User not found" });

  const [orders, txns, refunds, complaints, tickets, spend, ratingSummary, ratingsReceived, ratingsWritten] = await Promise.all([
    prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, orderCode: true, status: true, costPaise: true, pagesToPrint: true,
        copies: true, colorMode: true, paymentMethod: true, createdAt: true,
        document: { select: { fileName: true, fileType: true } },
        printer: { select: { id: true, name: true, uniquePrinterId: true, shopName: true, locationName: true } },
      },
    }),
    prisma.pointsTransaction.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true, type: true, amountPoints: true, balancePoints: true,
        amountPaise: true, balancePaise: true, description: true, orderId: true, createdAt: true,
      },
    }),
    prisma.refund.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, amountPaise: true, pointsCredited: true, reason: true,
        origin: true, note: true, createdAt: true,
        order: { select: { orderCode: true } },
      },
    }),
    prisma.complaint.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, code: true, category: true, subject: true, status: true,
        resolution: true, createdAt: true, resolvedAt: true,
      },
    }),
    prisma.supportTicket.findMany({
      where: { userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: { id: true, subject: true, status: true, reply: true, createdAt: true },
    }),
    prisma.order.aggregate({
      _sum: { costPaise: true, pagesToPrint: true },
      where: { userId, status: "COMPLETED" },
    }),
    // How shops rate this customer, and what they wrote — both sides, because a
    // one-star review a user left is often the context for the one they got.
    summarize({ userId }),
    prisma.rating.findMany({
      where: { userId, direction: "VENDOR_TO_USER" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: RATING_ADMIN_SELECT,
    }),
    prisma.rating.findMany({
      where: { authorId: userId, direction: "USER_TO_VENDOR" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: RATING_ADMIN_SELECT,
    }),
  ]);

  // Printers this user has actually used, most-used first.
  const usage = new Map<string, { printer: any; orders: number; lastUsedAt: Date }>();
  for (const o of orders) {
    if (!o.printer) continue;
    const entry = usage.get(o.printer.id);
    if (entry) {
      entry.orders += 1;
      if (o.createdAt > entry.lastUsedAt) entry.lastUsedAt = o.createdAt;
    } else {
      usage.set(o.printer.id, { printer: o.printer, orders: 1, lastUsedAt: o.createdAt });
    }
  }
  const savedPrinters = Array.from(usage.values())
    .sort((a, b) => b.orders - a.orders)
    .map((u) => ({ ...u.printer, orders: u.orders, lastUsedAt: u.lastUsedAt }));

  // Timeline, newest first, capped — a heavy user has hundreds of events.
  const activity = [
    ...orders.map((o) => ({
      at: o.createdAt,
      kind: "ORDER" as const,
      title: `Order ${o.orderCode} · ${o.status.replace(/_/g, " ").toLowerCase()}`,
      detail: o.document?.fileName || `${o.pagesToPrint} page(s)`,
    })),
    ...txns.map((t) => ({
      at: t.createdAt,
      kind: t.type === "CREDIT" ? ("CREDIT" as const) : ("DEBIT" as const),
      title: t.description,
      detail: `${t.type === "CREDIT" ? "+" : "−"}${t.amountPoints || Math.round(t.amountPaise / 10)} pts`,
    })),
    ...complaints.map((c) => ({
      at: c.createdAt,
      kind: "REPORT" as const,
      title: `Reported: ${c.subject}`,
      detail: c.status.replace(/_/g, " ").toLowerCase(),
    })),
    ...refunds.map((r) => ({
      at: r.createdAt,
      kind: "REFUND" as const,
      title: `Refund for ${r.order?.orderCode || "an order"}`,
      detail: `+${r.pointsCredited} pts · ${r.reason.replace(/_/g, " ").toLowerCase()}`,
    })),
    { at: user.createdAt, kind: "JOINED" as const, title: "Account created", detail: user.role },
  ]
    .sort((a, b) => b.at.getTime() - a.at.getTime())
    .slice(0, 150);

  res.json({
    user,
    summary: {
      totalOrders: user._count.orders,
      completedSpendPaise: spend._sum.costPaise || 0,
      pagesPrinted: spend._sum.pagesToPrint || 0,
      pointsBalance: user.pointsBalance,
      refunds: user._count.refunds,
      complaints: user._count.complaints,
      invited: user.referrals.length,
      invitedConverted: user.referrals.filter((r) => r.referralRewardedAt).length,
      printersUsed: savedPrinters.length,
    },
    orders,
    transactions: txns,
    refunds,
    complaints,
    tickets,
    savedPrinters,
    activity,
    ratingSummary,
    ratingsReceived,
    ratingsWritten,
  });
});

// ── Payout accounts across the platform ──────────────────────────────────────
// Read-only. The account number is masked to its last four digits here exactly
// as it is for its owner: an operator needs to recognise an account and see
// whether it has been verified, never to move money with it.
adminRouter.get("/bank-accounts", async (_req, res) => {
  const accounts = await prisma.bankAccount.findMany({
    orderBy: { updatedAt: "desc" },
    take: 200,
    select: {
      id: true,
      accountHolder: true,
      accountNumber: true,
      ifsc: true,
      bankName: true,
      branch: true,
      upiId: true,
      verified: true,
      createdAt: true,
      updatedAt: true,
      user: {
        select: {
          id: true,
          name: true,
          phone: true,
          email: true,
          role: true,
          vendor: { select: { shopName: true } },
        },
      },
    },
  });

  res.json({
    total: accounts.length,
    verified: accounts.filter((a) => a.verified).length,
    unverified: accounts.filter((a) => !a.verified).length,
    accounts: accounts.map(({ accountNumber, user, ...a }) => ({
      ...a,
      accountLast4: accountNumber.slice(-4),
      accountMasked: `••••••${accountNumber.slice(-4)}`,
      ownerName: user?.name || "—",
      ownerContact: user?.phone || user?.email || "—",
      ownerRole: user?.role || "—",
      shopName: user?.vendor?.shopName || null,
    })),
  });
});

// ── Referral activity across the platform ────────────────────────────────────
adminRouter.get("/referrals", async (_req, res) => {
  const [referrers, totalReferred, rewarded] = await Promise.all([
    // Only accounts that have actually invited someone. Listing every user with
    // a code would be a user directory, which /admin/users already is.
    prisma.user.findMany({
      where: { referrals: { some: {} } },
      orderBy: { createdAt: "desc" },
      take: 100,
      select: {
        id: true,
        name: true,
        phone: true,
        email: true,
        referralCode: true,
        createdAt: true,
        referrals: {
          orderBy: { createdAt: "desc" },
          select: {
            id: true,
            name: true,
            createdAt: true,
            referralRewardedAt: true,
          },
        },
      },
    }),
    prisma.user.count({ where: { referredById: { not: null } } }),
    prisma.user.count({ where: { referralRewardedAt: { not: null } } }),
  ]);

  res.json({
    totalReferrers: referrers.length,
    totalReferred,
    rewarded,
    /** Signed up through a code but haven't completed a first print yet. */
    pending: totalReferred - rewarded,
    referrerPoints: REFERRER_REWARD_POINTS,
    refereePoints: REFEREE_REWARD_POINTS,
    pointsPaidOut: rewarded * (REFERRER_REWARD_POINTS + REFEREE_REWARD_POINTS),
    referrers: referrers.map((r) => ({
      id: r.id,
      name: r.name,
      contact: r.phone || r.email || "—",
      code: r.referralCode,
      joinedAt: r.createdAt,
      invited: r.referrals.length,
      converted: r.referrals.filter((i) => i.referralRewardedAt).length,
      invitees: r.referrals.map((i) => ({
        id: i.id,
        name: i.name,
        joinedAt: i.createdAt,
        rewarded: !!i.referralRewardedAt,
      })),
    })),
  });
});

adminRouter.patch("/kiosks/:id", async (req, res) => {
  const { paperLevel, tonerLevel, status } = req.body;
  const kiosk = await prisma.printer.update({
    where: { id: req.params.id },
    data: {
      ...(paperLevel !== undefined ? { paperLevel: Math.max(0, Math.min(100, paperLevel)) } : {}),
      ...(tonerLevel !== undefined ? { tonerLevel: Math.max(0, Math.min(100, tonerLevel)) } : {}),
      ...(status ? { status } : {}),
    },
  });
  res.json({ kiosk });
});

// ── Support tickets ────────────────────────────────────────────────────────────
adminRouter.get("/support", async (req, res) => {
  const { status, limit = "50", offset = "0" } = req.query as Record<string, string>;
  const where: any = status ? { status } : {};

  const [tickets, total] = await Promise.all([
    prisma.supportTicket.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
    }),
    prisma.supportTicket.count({ where }),
  ]);
  res.json({ tickets, total });
});

adminRouter.patch("/support/:id", async (req, res) => {
  const { status, reply } = req.body as { status?: string; reply?: string };
  const ticket = await prisma.supportTicket.update({
    where: { id: req.params.id },
    data: {
      ...(status ? { status } : {}),
      ...(reply !== undefined ? { reply } : {}),
    },
  });
  res.json({ ticket });
});

// ── Rating moderation ────────────────────────────────────────────────────────
// Both directions in one queue. Staff can hide a rating but not edit or delete
// it: the point of moderation here is to stop abuse being displayed, not to
// rewrite what someone said. See ratings/service.ts for why hiding still counts
// as "already rated".
adminRouter.get("/ratings/stats", async (_req, res) => {
  res.json(await adminRatingStats());
});

adminRouter.get("/ratings", async (req, res) => {
  const q = req.query as Record<string, string>;
  const result = await listRatingsForAdmin({
    direction: q.direction === "USER_TO_VENDOR" || q.direction === "VENDOR_TO_USER" ? q.direction : undefined,
    status: q.status === "VISIBLE" || q.status === "HIDDEN" ? q.status : undefined,
    vendorId: q.vendorId || undefined,
    userId: q.userId || undefined,
    maxStars: q.maxStars ? Math.min(Math.max(parseInt(q.maxStars) || 0, 1), 5) : undefined,
    search: q.search || undefined,
    limit: parseInt(q.limit) || 50,
    skip: parseInt(q.offset) || 0,
  });
  res.json(result);
});

adminRouter.patch("/ratings/:id", async (req: AuthedRequest, res) => {
  const parsed = z
    .object({
      status: z.enum(["VISIBLE", "HIDDEN"]),
      reason: z.string().trim().max(500).optional(),
    })
    .safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update" });

  const rating = await setRatingVisibility(req.params.id, parsed.data.status === "HIDDEN", {
    adminId: req.user!.userId,
    reason: parsed.data.reason,
  });
  if (!rating) return res.status(404).json({ error: "Rating not found" });

  res.json({ rating });
});

// ── Platform settings ──────────────────────────────────────────────────────────
adminRouter.get("/settings", async (_req, res) => {
  const settings = await readSettings();
  res.json({ settings: maskSecrets(settings) });
});

adminRouter.put("/settings", async (req, res) => {
  const saved = await writeSettings(req.body?.settings ?? req.body);
  res.json({ settings: maskSecrets(saved) });
});
