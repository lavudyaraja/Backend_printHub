// Vendor profile and branch locations, for the vendor console.
//
// A vendor is a shop owner; a location is one of the places they operate from.
// Printers hang off a location, which is what makes "the same printer model at
// three different branches" unambiguous — three Printer rows, three locations,
// one vendor, and a scanned QR that resolves to exactly one of them.
import { Router, type Response } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";
import { requireVendorId, vendorIdFor, isVendorRole, isAdminRole } from "../lib/vendorScope";
import { RATING_SELECT } from "../ratings/types";
import { readSettings } from "../lib/settings";
import { vendorSettlementGross } from "../lib/settlement";

export const vendorsRouter = Router();

/** Paper/toner at or below this are worth flagging on the console. */
const LOW_SUPPLY = 20;

/**
 * Resolve what the caller is allowed to see.
 *
 * The vendor console was built against `/admin/*`, which is ADMIN-only — so a
 * real shop owner got a 403 on every page, and staff opening the same console
 * saw platform-wide figures presented as if they were one shop's. Every
 * vendor-facing route goes through this instead: a vendor is scoped to their own
 * rows, an admin sees everything.
 *
 * Returns null when it has already replied; callers must return immediately.
 */
async function resolveScope(
  req: AuthedRequest,
  res: Response,
): Promise<{ vendorId?: string } | null> {
  if (isAdminRole(req.user?.role)) return {};
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return null;
  return { vendorId };
}

// ── The signed-in vendor's own operating picture ─────────────────────────────
//
// Everything here is scoped to the caller's own printers. The console used to
// read this from /admin/*, which is ADMIN-only — so a real vendor got a 403,
// and an admin got platform-wide figures that weren't theirs to act on. These
// answer the questions a shop owner actually has: who is printing on my
// machines, and which machine needs attention.
vendorsRouter.get("/me/stats", requireAuth, async (req: AuthedRequest, res) => {
  const scope = await resolveScope(req, res);
  if (!scope) return;
  const orderWhere = scope;
  const printerWhere = scope;

  const now = new Date();
  const startOfDay = new Date(now.getFullYear(), now.getMonth(), now.getDate());
  const startOfMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);

  const [
    printers, orderCounts, customers, customersThisMonth, ordersToday, revenue,
    monthlyOrders, lastMonthOrders, revenueMonth, revenueLastMonth, pagesAll, newCustomersToday,
  ] = await Promise.all([
      prisma.printer.findMany({
        where: printerWhere,
        select: {
          id: true, name: true, uniquePrinterId: true, shopName: true, locationName: true,
          status: true, paperLevel: true, tonerLevel: true,
        },
        orderBy: { createdAt: "asc" },
      }),
      // One grouped query rather than a count per status.
      prisma.order.groupBy({ by: ["status"], where: orderWhere, _count: { _all: true } }),
      // "Members using my printers" = distinct customers who have ordered here.
      // Counting distinct userIds, not orders — one student printing 40 times is
      // one customer.
      prisma.order.findMany({
        where: orderWhere,
        select: { userId: true },
        distinct: ["userId"],
      }),
      prisma.order.findMany({
        where: { ...orderWhere, createdAt: { gte: startOfMonth } },
        select: { userId: true },
        distinct: ["userId"],
      }),
      prisma.order.count({ where: { ...orderWhere, createdAt: { gte: startOfDay } } }),
      prisma.order.aggregate({
        _sum: { costPaise: true },
        where: { ...orderWhere, status: "COMPLETED" },
      }),
      prisma.order.count({ where: { ...orderWhere, createdAt: { gte: startOfMonth } } }),
      prisma.order.count({ where: { ...orderWhere, createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
      prisma.order.aggregate({ _sum: { costPaise: true }, where: { ...orderWhere, status: "COMPLETED", createdAt: { gte: startOfMonth } } }),
      prisma.order.aggregate({ _sum: { costPaise: true }, where: { ...orderWhere, status: "COMPLETED", createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
      prisma.order.aggregate({ _sum: { pagesToPrint: true }, where: { ...orderWhere, status: "COMPLETED" } }),
      prisma.order.findMany({
        where: { ...orderWhere, createdAt: { gte: startOfDay } },
        select: { userId: true },
        distinct: ["userId"],
      }),
    ]);

  const countFor = (s: string) => orderCounts.find((r) => r.status === s)?._count._all ?? 0;
  const totalOrders = orderCounts.reduce((sum, r) => sum + r._count._all, 0);

  const failedOrders = countFor("FAILED");
  const cancelledOrders = countFor("CANCELLED");

  // Per-printer workload, so a shop with several machines can see which one is
  // carrying the load and which one is sitting idle or broken.
  const perPrinter = await prisma.order.groupBy({
    by: ["printerId"],
    where: orderWhere,
    _count: { _all: true },
  });
  const ordersFor = new Map(perPrinter.map((r) => [r.printerId, r._count._all]));

  const failedPerPrinter = await prisma.order.groupBy({
    by: ["printerId"],
    where: { ...orderWhere, status: "FAILED" },
    _count: { _all: true },
  });
  const failuresFor = new Map(failedPerPrinter.map((r) => [r.printerId, r._count._all]));

  // Earnings per machine. Reported rather than zero-filled — the orders page
  // prints this as money, and a placeholder zero there reads as "this printer
  // earned nothing".
  const revenuePerPrinter = await prisma.order.groupBy({
    by: ["printerId"],
    where: { ...orderWhere, status: "COMPLETED" },
    _sum: { costPaise: true, pagesToPrint: true },
  });
  const earningsFor = new Map(revenuePerPrinter.map((r) => [r.printerId, r._sum]));

  const thisMonthRevenue = revenueMonth._sum.costPaise || 0;
  const lastMonthRevenue = revenueLastMonth._sum.costPaise || 0;
  const revenuePaise = revenue._sum.costPaise || 0;

  res.json({
    // The console was written against the admin metrics shape, so this answers
    // in those field names too — same numbers, scoped to this shop. Renaming
    // them across four pages would buy nothing but churn.
    dailyOrders: ordersToday,
    monthlyOrders,
    orderGrowth: lastMonthOrders === 0 ? 100 : Math.round(((monthlyOrders - lastMonthOrders) / lastMonthOrders) * 100),
    totalUsers: customers.length,
    newUsersToday: newCustomersToday.length,
    totalRevenuePaise: revenuePaise,
    monthlyRevenuePaise: thisMonthRevenue,
    revenueGrowth: lastMonthRevenue === 0 ? 100 : Math.round(((thisMonthRevenue - lastMonthRevenue) / lastMonthRevenue) * 100),
    totalPagesPrinted: pagesAll._sum.pagesToPrint || 0,
    activePrinters: printers.filter((p) => p.status === "ONLINE").length,
    offlinePrinters: printers.filter((p) => p.status === "OFFLINE").length,
    lowPaperCount: printers.filter((p) => p.paperLevel <= LOW_SUPPLY).length,
    // Same rows the orders page renders as "Orders per printer".
    printerBreakdown: printers.map((p) => ({
      id: p.id,
      name: p.name,
      shopName: p.shopName,
      locationName: p.locationName,
      uniquePrinterId: p.uniquePrinterId,
      status: p.status as string,
      orders: ordersFor.get(p.id) || 0,
      revenuePaise: earningsFor.get(p.id)?.costPaise || 0,
      pagesPrinted: earningsFor.get(p.id)?.pagesToPrint || 0,
    })),

    customers: customers.length,
    customersThisMonth: customersThisMonth.length,
    totalOrders,
    ordersToday,
    completedOrders: countFor("COMPLETED"),
    printingOrders: countFor("PRINTING"),
    failedOrders,
    cancelledOrders,
    // Share of orders that ended badly — the number a shop owner should watch.
    failureRate: totalOrders > 0 ? Math.round((failedOrders / totalOrders) * 100) : 0,
    rejectionRate: totalOrders > 0 ? Math.round((cancelledOrders / totalOrders) * 100) : 0,
    revenuePaise,
    totalPrinters: printers.length,
    onlinePrinters: printers.filter((p) => p.status === "ONLINE").length,
    needsAttention: printers.filter(
      (p) =>
        p.status === "ERROR" ||
        p.status === "OUT_OF_PAPER" ||
        p.paperLevel <= LOW_SUPPLY ||
        p.tonerLevel <= LOW_SUPPLY,
    ).length,
    printers: printers.map((p) => ({
      ...p,
      orders: ordersFor.get(p.id) || 0,
      failures: failuresFor.get(p.id) || 0,
      lowPaper: p.paperLevel <= LOW_SUPPLY,
      lowToner: p.tonerLevel <= LOW_SUPPLY,
    })),
    lowSupplyThreshold: LOW_SUPPLY,
  });
});

// ── This shop's orders ───────────────────────────────────────────────────────
vendorsRouter.get("/me/orders", requireAuth, async (req: AuthedRequest, res) => {
  const scope = await resolveScope(req, res);
  if (!scope) return;

  const { status, search, limit = "100", offset = "0" } = req.query as Record<string, string>;

  const { userId } = req.query as Record<string, string>;

  const where: any = { ...scope };
  if (status) where.status = status;
  // Exact-customer filter, for the customer history view. Searching by name
  // cannot do this job: two customers can share a name, and showing one person
  // another's print history would be a real leak.
  if (userId) where.userId = userId;
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
      take: Math.min(parseInt(limit) || 100, 200),
      skip: parseInt(offset) || 0,
      select: {
        id: true, orderCode: true, status: true, colorMode: true, sideMode: true,
        copies: true, pagesToPrint: true, paperSize: true, costPaise: true,
        paymentMethod: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true, email: true } },
        document: { select: { fileName: true, pageCount: true } },
        printer: { select: { name: true, shopName: true, uniquePrinterId: true } },
      },
    }),
    prisma.order.count({ where }),
  ]);

  res.json({ orders, total });
});

// ── This shop's revenue, by day ──────────────────────────────────────────────
vendorsRouter.get("/me/revenue", requireAuth, async (req: AuthedRequest, res) => {
  const scope = await resolveScope(req, res);
  if (!scope) return;

  const { period = "30d" } = req.query as { period?: string };
  const days = period === "7d" ? 7 : period === "90d" ? 90 : 30;

  const since = new Date();
  since.setDate(since.getDate() - days);
  since.setHours(0, 0, 0, 0);

  const orders = await prisma.order.findMany({
    where: { ...scope, status: "COMPLETED", createdAt: { gte: since } },
    select: { createdAt: true, costPaise: true, pagesToPrint: true, colorMode: true, printerId: true },
    orderBy: { createdAt: "asc" },
  });

  // Seed every day in range so the chart has no gaps on quiet days.
  const dayMap = new Map<string, { date: string; revenuePaise: number; orders: number; pages: number; bwOrders: number; colorOrders: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since);
    d.setDate(d.getDate() + i);
    const key = d.toISOString().split("T")[0];
    dayMap.set(key, { date: key, revenuePaise: 0, orders: 0, pages: 0, bwOrders: 0, colorOrders: 0 });
  }
  for (const o of orders) {
    const entry = dayMap.get(o.createdAt.toISOString().split("T")[0]);
    if (!entry) continue;
    entry.revenuePaise += o.costPaise;
    entry.orders += 1;
    entry.pages += o.pagesToPrint;
    if (o.colorMode === "COLOR") entry.colorOrders += 1;
    else entry.bwOrders += 1;
  }

  const topPrinters = await prisma.order.groupBy({
    by: ["printerId"],
    where: { ...scope, status: "COMPLETED", createdAt: { gte: since }, printerId: { not: null } },
    _sum: { costPaise: true },
    _count: { id: true },
    orderBy: { _sum: { costPaise: "desc" } },
    take: 5,
  });
  const names = await prisma.printer.findMany({
    where: { id: { in: topPrinters.map((p) => p.printerId).filter(Boolean) as string[] } },
    select: { id: true, name: true, shopName: true },
  });

  res.json({
    chartData: Array.from(dayMap.values()),
    topPrinters: topPrinters.map((p) => ({
      printerId: p.printerId,
      name: names.find((n) => n.id === p.printerId)?.name || "Unknown",
      revenuePaise: p._sum.costPaise || 0,
      orders: p._count.id,
    })),
  });
});

// ── The people who print here ────────────────────────────────────────────────
vendorsRouter.get("/me/customers", requireAuth, async (req: AuthedRequest, res) => {
  const scope = await resolveScope(req, res);
  if (!scope) return;

  // Grouped in the database — a busy shop has more orders than it has customers,
  // and pulling every order back to count them client-side does not scale.
  const grouped = await prisma.order.groupBy({
    by: ["userId"],
    where: scope,
    _count: { _all: true },
    _sum: { costPaise: true, pagesToPrint: true },
    orderBy: { _count: { userId: "desc" } },
    take: 200,
  });

  const users = await prisma.user.findMany({
    where: { id: { in: grouped.map((g) => g.userId) } },
    select: {
      id: true, name: true, phone: true, email: true, pointsBalance: true, createdAt: true,
      // The customer's standing across every shop, so a vendor can see who they
      // are dealing with before the order rather than after it.
      ratingAvg: true, ratingCount: true,
    },
  });
  const byId = new Map(users.map((u) => [u.id, u]));

  res.json({
    total: grouped.length,
    customers: grouped
      .map((g) => {
        const u = byId.get(g.userId);
        return u
          ? {
              ...u,
              orders: g._count._all,
              spentPaise: g._sum.costPaise || 0,
              pagesPrinted: g._sum.pagesToPrint || 0,
            }
          : null;
      })
      .filter(Boolean),
  });
});

// ── Points movements tied to this shop ───────────────────────────────────────
// A shop doesn't hold a points ledger — the platform does. What a vendor can
// legitimately see is the movements attached to orders placed at their own
// printers, which is what this returns. Platform-wide top-ups are not included.
vendorsRouter.get("/me/transactions", requireAuth, async (req: AuthedRequest, res) => {
  const scope = await resolveScope(req, res);
  if (!scope) return;

  const { search, type, limit = "50", offset = "0" } = req.query as Record<string, string>;

  // Admins see the whole ledger; a vendor sees only rows pointing at their orders.
  let where: any = {};
  if (scope.vendorId) {
    const orderIds = await prisma.order.findMany({
      where: { vendorId: scope.vendorId },
      select: { id: true },
    });
    where.orderId = { in: orderIds.map((o) => o.id) };
  }
  if (type) where.type = type;
  if (search) {
    where.OR = [
      { description: { contains: search, mode: "insensitive" } },
      { user: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [transactions, total] = await Promise.all([
    prisma.pointsTransaction.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      select: {
        id: true, type: true, amountPoints: true, balancePoints: true,
        amountPaise: true, balancePaise: true, description: true,
        razorpayId: true, createdAt: true,
        user: { select: { name: true, phone: true } },
      },
    }),
    prisma.pointsTransaction.count({ where }),
  ]);

  res.json({ transactions, total });
});

// ── The signed-in vendor's own profile ───────────────────────────────────────
vendorsRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  // Admins maintain every shop, so they can open the vendor console to look.
  // If they have no vendor profile of their own this returns null, which the
  // console already renders as a "finish setting up" state.
  if (!isVendorRole(req.user?.role) && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ error: "This is a vendor-only action." });
  }
  const vendor = await prisma.vendor.findUnique({
    where: { userId: req.user!.userId },
    include: {
      locations: {
        orderBy: { createdAt: "asc" },
        include: { _count: { select: { printers: true } } },
      },
      _count: { select: { printers: true, orders: true } },
    },
  });
  // Null rather than 404: the console renders a "finish setting up" state, and a
  // 404 here would read as a broken endpoint.
  res.json({ vendor });
});

/** The seven keys a week is stored under. Order is display order. */
const DAY_KEYS = ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] as const;

const TIME = /^([01]\d|2[0-3]):[0-5]\d$/;

/**
 * One day's hours. `closed` days keep their times so a shop that closes Sunday
 * and reopens it later doesn't have to retype them.
 */
const daySchema = z.object({
  open: z.string().regex(TIME, "Use 24-hour HH:MM"),
  close: z.string().regex(TIME, "Use 24-hour HH:MM"),
  closed: z.boolean().default(false),
});

const hoursSchema = z.object(
  Object.fromEntries(DAY_KEYS.map((d) => [d, daySchema])) as Record<
    (typeof DAY_KEYS)[number],
    typeof daySchema
  >
);

const profileSchema = z.object({
  shopName: z.string().min(2, "Enter your shop name"),
  contactName: z.string().min(2).optional(),
  mobileNumber: z.string().min(10).optional(),
});

/** Create the vendor profile on first use, or update it later. */
vendorsRouter.put("/me", requireAuth, async (req: AuthedRequest, res) => {
  // Admins run the vendor console too (often their own shop), so they edit their
  // own profile here just like a vendor. Only a plain student is turned away.
  if (!isVendorRole(req.user?.role) && !isAdminRole(req.user?.role)) {
    return res.status(403).json({ error: "This is a vendor-only action." });
  }
  const parsed = profileSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });

  const userId = req.user!.userId;
  const vendor = await prisma.vendor.upsert({
    where: { userId },
    create: { userId, ...parsed.data },
    update: parsed.data,
  });
  res.json({ vendor });
});

// ── One customer, in full ────────────────────────────────────────────────────
//
// Everything the vendor console's customer profile shows, in a single round
// trip: who they are, what they've printed here, what they paid, and how the
// two of you have rated each other.
//
// Scoped twice over. The orders are filtered to this shop, and a customer who
// has never ordered here is reported as missing rather than returned empty — a
// vendor must not be able to look up an arbitrary user id and learn their name
// and phone number.
vendorsRouter.get("/me/customers/:userId", requireAuth, async (req: AuthedRequest, res) => {
  const scope = await resolveScope(req, res);
  if (!scope) return;

  const { userId } = req.params;
  const orderWhere = { ...scope, userId };

  const orders = await prisma.order.findMany({
    where: orderWhere,
    orderBy: { createdAt: "desc" },
    take: 300,
    select: {
      id: true, orderCode: true, status: true, colorMode: true, sideMode: true,
      copies: true, pagesToPrint: true, paperSize: true, costPaise: true,
      paymentMethod: true, createdAt: true, updatedAt: true,
      document: { select: { fileName: true, fileType: true, pageCount: true } },
      printer: { select: { id: true, name: true, uniquePrinterId: true, locationName: true } },
      refund: { select: { id: true, pointsCredited: true, reason: true, createdAt: true } },
    },
  });

  // No history here means this shop has no business seeing the account.
  if (orders.length === 0) return res.status(404).json({ error: "Customer not found" });

  const user = await prisma.user.findUnique({
    where: { id: userId },
    select: {
      id: true, name: true, phone: true, email: true, rollNumber: true,
      ratingAvg: true, ratingCount: true, createdAt: true,
      bannedAt: true,
    },
  });
  if (!user) return res.status(404).json({ error: "Customer not found" });

  const orderIds = orders.map((o) => o.id);

  const [transactions, ratingsFromShop, ratingsFromCustomer, refundRequests] = await Promise.all([
    // Points movements tied to *this shop's* orders only. A vendor has no
    // business seeing the customer's top-ups or their spend at other shops.
    prisma.pointsTransaction.findMany({
      where: { userId, orderId: { in: orderIds } },
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, type: true, amountPoints: true, description: true,
        orderId: true, createdAt: true,
      },
    }),
    prisma.rating.findMany({
      where: { ...scope, userId, direction: "VENDOR_TO_USER" },
      orderBy: { createdAt: "desc" },
      select: RATING_SELECT,
    }),
    prisma.rating.findMany({
      where: { ...scope, userId, direction: "USER_TO_VENDOR", status: "VISIBLE" },
      orderBy: { createdAt: "desc" },
      select: RATING_SELECT,
    }),
    prisma.refundRequest.findMany({
      where: { ...scope, userId },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, code: true, reason: true, status: true, description: true,
        decisionNote: true, decidedAt: true, createdAt: true,
        order: { select: { id: true, orderCode: true, costPaise: true } },
      },
    }),
  ]);

  const completed = orders.filter((o) => o.status === "COMPLETED");
  const failed = orders.filter((o) => o.status === "FAILED" || o.status === "CANCELLED");

  // "Visits" is distinct calendar days with an order, not the order count — a
  // student who prints four documents in one sitting walked in once. Local date
  // keys, because a visit is a day in the shop's world, not a UTC instant.
  const dayKey = (d: Date) =>
    `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, "0")}-${String(d.getDate()).padStart(2, "0")}`;
  const visitDays = new Map<string, { date: string; orders: number; pages: number; spentPaise: number }>();
  for (const o of orders) {
    const key = dayKey(o.createdAt);
    const entry = visitDays.get(key) || { date: key, orders: 0, pages: 0, spentPaise: 0 };
    entry.orders += 1;
    entry.pages += o.pagesToPrint * o.copies;
    if (o.status === "COMPLETED") entry.spentPaise += o.costPaise;
    visitDays.set(key, entry);
  }
  const visits = Array.from(visitDays.values()).sort((a, b) => b.date.localeCompare(a.date));

  const spentPaise = completed.reduce((s, o) => s + o.costPaise, 0);
  const pagesPrinted = completed.reduce((s, o) => s + o.pagesToPrint * o.copies, 0);
  const refundedPaise = orders.reduce((s, o) => s + (o.refund ? o.costPaise : 0), 0);

  // Which machine they actually use, most-used first.
  const byPrinter = new Map<string, { printer: any; orders: number }>();
  for (const o of orders) {
    if (!o.printer) continue;
    const entry = byPrinter.get(o.printer.id);
    if (entry) entry.orders += 1;
    else byPrinter.set(o.printer.id, { printer: o.printer, orders: 1 });
  }
  const printersUsed = Array.from(byPrinter.values()).sort((a, b) => b.orders - a.orders);

  const first = orders[orders.length - 1];
  const last = orders[0];

  res.json({
    customer: user,
    summary: {
      totalOrders: orders.length,
      completedOrders: completed.length,
      failedOrders: failed.length,
      pagesPrinted,
      spentPaise,
      refundedPaise,
      avgOrderPaise: completed.length ? Math.round(spentPaise / completed.length) : 0,
      /// How many separate times they came in — see the note above.
      visits: visits.length,
      firstOrderAt: first?.createdAt ?? null,
      lastOrderAt: last?.createdAt ?? null,
      printersUsed: printersUsed.length,
      refundRequests: refundRequests.length,
    },
    orders,
    visits,
    printersUsed,
    transactions,
    ratings: { fromShop: ratingsFromShop, fromCustomer: ratingsFromCustomer },
    refundRequests,
  });
});

// ── Settlements ──────────────────────────────────────────────────────────────
//
// Payments are collected in full into the platform account; a shop's share is
// settled to it afterwards by payout. This endpoint tells a shop what it has
// earned (cost less commission across its completed orders, net of the refunded
// portion of any partial print), what has already been paid out, and what is
// still owed. There is no gateway onboarding here anymore — a bank account on
// file is all a shop needs to be paid.

/** What this shop has earned, been paid, and is still owed. */
vendorsRouter.get("/me/route/status", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      user: { select: { bankAccount: { select: { accountHolder: true, accountNumber: true, ifsc: true, bankName: true } } } },
    },
  });

  const settings = await readSettings();
  const rate = settings.pricing?.commissionPercent ?? 0;

  const [earned, paidAgg, recent] = await Promise.all([
    vendorSettlementGross(vendorId),
    prisma.payout.aggregate({
      where: { vendorId, status: "PAID" },
      _sum: { netPaise: true },
      _count: { _all: true },
    }),
    prisma.order.findMany({
      where: { vendorId, status: "COMPLETED" },
      orderBy: { createdAt: "desc" },
      take: 50,
      select: {
        id: true, orderCode: true, costPaise: true, settlementPaise: true,
        printedPages: true, pagesToPrint: true, status: true, createdAt: true,
        paymentMethod: true,
      },
    }),
  ]);

  const gross = earned.grossPaise;
  const commission = Math.round((gross * rate) / 100);
  const net = gross - commission;
  const paidOut = paidAgg._sum.netPaise || 0;

  // Bank account, last four only — the shop confirms money is heading to the
  // right place without the full number ever leaving the server.
  const bank = vendor?.user?.bankAccount;
  const maskedBank = bank
    ? {
        accountHolder: bank.accountHolder,
        last4: bank.accountNumber.slice(-4),
        ifsc: bank.ifsc,
        bankName: bank.bankName,
      }
    : null;

  res.json({
    // A bank account on file is all onboarding is now; the platform settles the
    // rest, so a shop with a bank account is "active" for payouts.
    onboarded: !!bank,
    active: !!bank,
    statusNote: bank
      ? null
      : "Add your bank account so the platform can settle your earnings to you.",
    commissionPercent: rate,
    bank: maskedBank,
    settlements: {
      completedOrders: earned.orderCount,
      grossPaise: gross,
      commissionPaise: commission,
      netPaise: net,
      paidOutPaise: paidOut,
      pendingPaise: Math.max(0, net - paidOut),
      payoutCount: paidAgg._count._all,
    },
    recent,
  });
});

// ── KYC ──────────────────────────────────────────────────────────────────────
// The shop submits who it is (legal name + PAN/Aadhaar/GST numbers) so the
// platform can verify it before paying it. Numbers only — no document images.
// Submitting puts the shop "under review"; an admin approving it on the
// verifications queue is the same act as verifying the shop (verifiedAt).

const panRe = /^[A-Z]{5}[0-9]{4}[A-Z]$/;
const gstinRe = /^[0-9]{2}[A-Z]{5}[0-9]{4}[A-Z][0-9A-Z]Z[0-9A-Z]$/;

const kycSchema = z.object({
  legalName: z.string().trim().min(2, "Enter the legal name as printed on your PAN."),
  panNumber: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => panRe.test(s), "Enter a valid 10-character PAN (e.g. ABCDE1234F)."),
  aadhaarNumber: z
    .string()
    .trim()
    .transform((s) => s.replace(/\s+/g, ""))
    .refine((s) => /^[0-9]{12}$/.test(s), "Aadhaar must be 12 digits."),
  gstin: z
    .string()
    .trim()
    .transform((s) => s.toUpperCase())
    .refine((s) => s === "" || gstinRe.test(s), "Enter a valid 15-character GSTIN, or leave it blank.")
    .optional()
    .or(z.literal("")),
});

/** Derive the KYC/verification state from the timestamps. */
function kycStatus(v: {
  verifiedAt: Date | null;
  rejectedAt: Date | null;
  kycSubmittedAt: Date | null;
}): "VERIFIED" | "REJECTED" | "UNDER_REVIEW" | "NOT_SUBMITTED" {
  if (v.verifiedAt) return "VERIFIED";
  if (v.rejectedAt) return "REJECTED";
  if (v.kycSubmittedAt) return "UNDER_REVIEW";
  return "NOT_SUBMITTED";
}

/** The shop's own KYC, with the bank account it will be paid into. */
vendorsRouter.get("/me/kyc", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: {
      legalName: true, panNumber: true, aadhaarNumber: true, gstin: true,
      kycSubmittedAt: true, verifiedAt: true, rejectedAt: true, verificationNote: true,
      user: { select: { bankAccount: { select: { accountHolder: true, accountNumber: true, ifsc: true, bankName: true, verified: true } } } },
    },
  });
  if (!vendor) return res.status(404).json({ error: "Shop not found" });

  const bank = vendor.user?.bankAccount;
  res.json({
    status: kycStatus(vendor),
    legalName: vendor.legalName,
    panNumber: vendor.panNumber,
    aadhaarNumber: vendor.aadhaarNumber,
    gstin: vendor.gstin,
    note: vendor.verificationNote,
    submittedAt: vendor.kycSubmittedAt,
    verifiedAt: vendor.verifiedAt,
    rejectedAt: vendor.rejectedAt,
    bank: bank
      ? { accountHolder: bank.accountHolder, last4: bank.accountNumber.slice(-4), ifsc: bank.ifsc, bankName: bank.bankName, verified: bank.verified }
      : null,
  });
});

/** Submit or update KYC. Puts the shop back under review. */
vendorsRouter.put("/me/kyc", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const parsed = kycSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid KYC details" });
  }

  // The bank account is the "bank proof" leg of KYC — there's no point verifying
  // an identity we can't pay, so it must be on file before KYC can be submitted.
  const bank = await prisma.bankAccount.findUnique({
    where: { userId: req.user!.userId },
    select: { id: true },
  });
  if (!bank) {
    return res.status(409).json({
      error: "Add your bank account first — it's the bank proof for your KYC.",
      code: "NO_BANK_ACCOUNT",
    });
  }

  const d = parsed.data;
  const vendor = await prisma.vendor.update({
    where: { id: vendorId },
    data: {
      legalName: d.legalName,
      panNumber: d.panNumber,
      aadhaarNumber: d.aadhaarNumber,
      gstin: d.gstin ? d.gstin : null,
      kycSubmittedAt: new Date(),
      // A resubmission is a fresh review: clear any prior decision so the shop
      // doesn't stay "rejected" (or wrongly "verified") on edited details.
      verifiedAt: null,
      rejectedAt: null,
      verificationNote: null,
    },
    select: { verifiedAt: true, rejectedAt: true, kycSubmittedAt: true },
  });

  res.json({ status: kycStatus(vendor), submittedAt: vendor.kycSubmittedAt });
});

// ── Operating hours ──────────────────────────────────────────────────────────
// Stored as one Json blob on Vendor and always read and written whole — see the
// field's note in schema.prisma for why it isn't a table.
vendorsRouter.get("/me/hours", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const vendor = await prisma.vendor.findUnique({
    where: { id: vendorId },
    select: { operatingHours: true },
  });
  // Null rather than a default week: "never set" and "closed every day" are
  // different things, and the console says so.
  res.json({ hours: vendor?.operatingHours ?? null, days: DAY_KEYS });
});

vendorsRouter.put("/me/hours", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const parsed = hoursSchema.safeParse(req.body?.hours ?? req.body);
  if (!parsed.success) {
    const issue = parsed.error.errors[0];
    return res.status(400).json({
      error: issue?.message
        ? `${issue.path.join(".")}: ${issue.message}`
        : "Those opening hours aren't valid.",
    });
  }

  // A close time at or before the open time would render as a negative day.
  // Overnight shifts are not supported, and silently accepting one would show
  // customers a shop that is open "20:00 to 09:00".
  for (const day of DAY_KEYS) {
    const d = parsed.data[day];
    if (!d.closed && d.close <= d.open) {
      return res.status(400).json({
        error: `${day.toUpperCase()}: closing time must be after opening time.`,
      });
    }
  }

  const vendor = await prisma.vendor.update({
    where: { id: vendorId },
    data: { operatingHours: parsed.data },
    select: { operatingHours: true },
  });
  res.json({ hours: vendor.operatingHours });
});

// ── This shop's payouts ──────────────────────────────────────────────────────
// Read-only, and scoped to the caller's own shop. A payout is a record of a
// transfer staff have already made — nothing here moves money, and a vendor
// cannot create or alter one.
vendorsRouter.get("/me/payouts", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const [payouts, totals] = await Promise.all([
    prisma.payout.findMany({
      where: { vendorId },
      orderBy: { periodEnd: "desc" },
      take: 200,
      select: {
        id: true, grossPaise: true, commissionPaise: true, netPaise: true,
        periodStart: true, periodEnd: true, orderCount: true, status: true,
        reference: true, failureReason: true, note: true,
        processedAt: true, createdAt: true,
      },
    }),
    prisma.payout.aggregate({
      where: { vendorId, status: "PAID" },
      _sum: { netPaise: true, grossPaise: true, commissionPaise: true },
      _count: { _all: true },
    }),
  ]);

  res.json({
    payouts,
    totals: {
      paidCount: totals._count._all,
      paidNetPaise: totals._sum.netPaise || 0,
      paidGrossPaise: totals._sum.grossPaise || 0,
      commissionPaise: totals._sum.commissionPaise || 0,
    },
  });
});

// ── Locations ────────────────────────────────────────────────────────────────
const locationSchema = z.object({
  name: z.string().min(2, "Enter a name for this branch"),
  address: z.string().optional(),
});

vendorsRouter.get("/me/locations", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const locations = await prisma.location.findMany({
    where: { vendorId },
    orderBy: { createdAt: "asc" },
    include: { _count: { select: { printers: true } } },
  });
  res.json({ locations });
});

vendorsRouter.post("/me/locations", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const parsed = locationSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });

  const location = await prisma.location.create({ data: { vendorId, ...parsed.data } });
  res.status(201).json({ location });
});

vendorsRouter.put("/me/locations/:id", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  const parsed = locationSchema.partial().safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.errors[0]?.message });

  // Scoped by vendorId as well as id, so one vendor can't rename another's branch.
  const { count } = await prisma.location.updateMany({
    where: { id: req.params.id, vendorId },
    data: parsed.data,
  });
  if (count === 0) return res.status(404).json({ error: "Location not found" });

  const location = await prisma.location.findUnique({ where: { id: req.params.id } });
  res.json({ location });
});

vendorsRouter.delete("/me/locations/:id", requireAuth, async (req: AuthedRequest, res) => {
  const vendorId = await requireVendorId(req, res);
  if (!vendorId) return;

  // Deleting a branch would orphan its printers (locationId is SetNull), leaving
  // machines that belong nowhere. Make the vendor move them first.
  const printers = await prisma.printer.count({ where: { locationId: req.params.id } });
  if (printers > 0) {
    return res.status(409).json({
      error: `This branch still has ${printers} printer(s). Move or remove them first.`,
    });
  }

  const { count } = await prisma.location.deleteMany({ where: { id: req.params.id, vendorId } });
  if (count === 0) return res.status(404).json({ error: "Location not found" });
  res.json({ deleted: true });
});

// ── Admin: every vendor on the platform ──────────────────────────────────────
vendorsRouter.get("/", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const { search, limit = "50", offset = "0" } = req.query as Record<string, string>;

  const where = search
    ? {
        OR: [
          { shopName: { contains: search, mode: "insensitive" as const } },
          { user: { email: { contains: search, mode: "insensitive" as const } } },
        ],
      }
    : {};

  const [vendors, total] = await Promise.all([
    prisma.vendor.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: Math.min(parseInt(limit) || 50, 200),
      skip: parseInt(offset) || 0,
      include: {
        user: { select: { id: true, name: true, email: true, phone: true } },
        locations: { select: { id: true, name: true } },
        _count: { select: { printers: true, orders: true } },
      },
    }),
    prisma.vendor.count({ where }),
  ]);

  res.json({ vendors, total });
});

/** Admin: attach a printer that the backfill couldn't match to a vendor. */
vendorsRouter.post("/:id/printers/:printerId", requireAuth, requireRole("ADMIN"), async (req, res) => {
  const vendor = await prisma.vendor.findUnique({ where: { id: req.params.id }, select: { id: true } });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });

  try {
    const printer = await prisma.printer.update({
      where: { id: req.params.printerId },
      // The old location belonged to whoever owned it before; clear it so the
      // new vendor picks one of their own branches.
      data: { vendorId: vendor.id, locationId: null },
    });
    res.json({ printer });
  } catch (e: any) {
    if (e.code === "P2025") return res.status(404).json({ error: "Printer not found" });
    throw e;
  }
});
