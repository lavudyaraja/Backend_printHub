// Finance: revenue, transactions, refunds, commissions and payouts.
//
// ADMIN only. Everything here reports on money, so the rule throughout is that
// a figure is either computed from real rows or absent — never zero-filled.
// Where a concept has no record (a refund *request*, for instance), the route
// says so rather than inventing one.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, requireRole, type AuthedRequest } from "../middleware/authGuard";
import { readSettings } from "../lib/settings";
import { settlementGross, settlementGrossByVendor, vendorSettlementGross } from "../lib/settlement";

export const financeRouter = Router();
financeRouter.use(requireAuth, requireRole("ADMIN"));

/** Only completed orders are revenue. Anything else hasn't been earned. */
const EARNED = { status: "COMPLETED" as const };

function startOfDay(d: Date) {
  return new Date(d.getFullYear(), d.getMonth(), d.getDate());
}

/** ISO date key, used to bucket by day. */
function dayKey(d: Date) {
  return d.toISOString().split("T")[0];
}

// ── Revenue ──────────────────────────────────────────────────────────────────
financeRouter.get("/revenue", async (req, res) => {
  const { period = "30d" } = req.query as { period?: string };
  const days = period === "7d" ? 7 : period === "90d" ? 90 : period === "365d" ? 365 : 30;

  const now = new Date();
  const since = startOfDay(new Date(now.getTime() - (days - 1) * 86400000));
  const startOfThisMonth = new Date(now.getFullYear(), now.getMonth(), 1);
  const startOfLastMonth = new Date(now.getFullYear(), now.getMonth() - 1, 1);
  const endOfLastMonth = new Date(now.getFullYear(), now.getMonth(), 0, 23, 59, 59);
  const startOfWeek = startOfDay(new Date(now.getTime() - 6 * 86400000));

  const [all, today, thisWeek, thisMonth, lastMonth, inRange, byVendor, vendors, printers] =
    await Promise.all([
      prisma.order.aggregate({ _sum: { costPaise: true, pagesToPrint: true }, _count: { _all: true }, where: EARNED }),
      prisma.order.aggregate({ _sum: { costPaise: true }, _count: { _all: true }, where: { ...EARNED, createdAt: { gte: startOfDay(now) } } }),
      prisma.order.aggregate({ _sum: { costPaise: true }, _count: { _all: true }, where: { ...EARNED, createdAt: { gte: startOfWeek } } }),
      prisma.order.aggregate({ _sum: { costPaise: true }, _count: { _all: true }, where: { ...EARNED, createdAt: { gte: startOfThisMonth } } }),
      prisma.order.aggregate({ _sum: { costPaise: true }, _count: { _all: true }, where: { ...EARNED, createdAt: { gte: startOfLastMonth, lte: endOfLastMonth } } }),
      prisma.order.findMany({
        where: { ...EARNED, createdAt: { gte: since } },
        select: { createdAt: true, costPaise: true, pagesToPrint: true, colorMode: true, paymentMethod: true },
        orderBy: { createdAt: "asc" },
      }),
      prisma.order.groupBy({
        by: ["vendorId"],
        where: EARNED,
        _sum: { costPaise: true, pagesToPrint: true },
        _count: { _all: true },
      }),
      prisma.vendor.findMany({ select: { id: true, shopName: true } }),
      // Location is free text on the printer — there is no city field, so any
      // geographic grouping can only be as good as what a vendor typed.
      prisma.printer.findMany({ select: { id: true, locationName: true, vendorId: true } }),
    ]);

  // Seed every day so quiet days are zeros in the series rather than gaps.
  const daily = new Map<string, { date: string; revenuePaise: number; orders: number; pages: number; bw: number; color: number }>();
  for (let i = 0; i < days; i++) {
    const d = new Date(since.getTime() + i * 86400000);
    daily.set(dayKey(d), { date: dayKey(d), revenuePaise: 0, orders: 0, pages: 0, bw: 0, color: 0 });
  }
  for (const o of inRange) {
    const e = daily.get(dayKey(o.createdAt));
    if (!e) continue;
    e.revenuePaise += o.costPaise;
    e.orders += 1;
    e.pages += o.pagesToPrint;
    if (o.colorMode === "COLOR") e.color += 1;
    else e.bw += 1;
  }

  // Weekly and monthly roll-ups, from the same daily series.
  const series = Array.from(daily.values());
  const weekly: { weekStart: string; revenuePaise: number; orders: number }[] = [];
  for (let i = 0; i < series.length; i += 7) {
    const chunk = series.slice(i, i + 7);
    weekly.push({
      weekStart: chunk[0].date,
      revenuePaise: chunk.reduce((s, d) => s + d.revenuePaise, 0),
      orders: chunk.reduce((s, d) => s + d.orders, 0),
    });
  }
  const monthly = new Map<string, { month: string; revenuePaise: number; orders: number }>();
  for (const d of series) {
    const key = d.date.slice(0, 7);
    const e = monthly.get(key) || { month: key, revenuePaise: 0, orders: 0 };
    e.revenuePaise += d.revenuePaise;
    e.orders += d.orders;
    monthly.set(key, e);
  }

  const shopName = new Map(vendors.map((v) => [v.id, v.shopName]));
  const vendorRows = byVendor
    .map((r) => ({
      vendorId: r.vendorId,
      name: r.vendorId ? shopName.get(r.vendorId) || "Unknown shop" : "Unassigned",
      revenuePaise: r._sum.costPaise || 0,
      orders: r._count._all,
      pages: r._sum.pagesToPrint || 0,
    }))
    .sort((a, b) => b.revenuePaise - a.revenuePaise);

  // "By city" from the printer's locationName, which is the only geography the
  // platform records. Reported under that name so nobody mistakes it for a
  // validated city field.
  const vendorLocation = new Map<string, string>();
  for (const p of printers) {
    if (p.vendorId && p.locationName && !vendorLocation.has(p.vendorId)) {
      vendorLocation.set(p.vendorId, p.locationName);
    }
  }
  const byLocation = new Map<string, { location: string; revenuePaise: number; orders: number }>();
  for (const r of vendorRows) {
    const loc = (r.vendorId && vendorLocation.get(r.vendorId)) || "Unrecorded";
    const e = byLocation.get(loc) || { location: loc, revenuePaise: 0, orders: 0 };
    e.revenuePaise += r.revenuePaise;
    e.orders += r.orders;
    byLocation.set(loc, e);
  }

  const thisMonthRev = thisMonth._sum.costPaise || 0;
  const lastMonthRev = lastMonth._sum.costPaise || 0;

  res.json({
    total: { revenuePaise: all._sum.costPaise || 0, orders: all._count._all, pages: all._sum.pagesToPrint || 0 },
    today: { revenuePaise: today._sum.costPaise || 0, orders: today._count._all },
    week: { revenuePaise: thisWeek._sum.costPaise || 0, orders: thisWeek._count._all },
    month: { revenuePaise: thisMonthRev, orders: thisMonth._count._all },
    lastMonth: { revenuePaise: lastMonthRev, orders: lastMonth._count._all },
    // Null rather than 100% when there is nothing to compare against — a growth
    // figure off a zero base is meaningless.
    monthGrowth: lastMonthRev === 0 ? null : Math.round(((thisMonthRev - lastMonthRev) / lastMonthRev) * 100),
    averageOrderPaise: all._count._all > 0 ? Math.round((all._sum.costPaise || 0) / all._count._all) : 0,
    daily: series,
    weekly,
    monthly: Array.from(monthly.values()),
    byVendor: vendorRows,
    byLocation: Array.from(byLocation.values()).sort((a, b) => b.revenuePaise - a.revenuePaise),
    periodDays: days,
  });
});

// ── Transactions ─────────────────────────────────────────────────────────────
// Two different things share this name: money orders (paid by UPI or points)
// and the points ledger. Both are returned so the console can show each.
financeRouter.get("/transactions", async (req, res) => {
  const { method, status, search } = req.query as Record<string, string>;

  const where: any = {};
  if (method === "UPI") where.paymentMethod = "UPI";
  if (method === "POINTS") where.paymentMethod = "POINTS";
  if (status) where.status = status;
  if (search) {
    where.OR = [
      { orderCode: { contains: search, mode: "insensitive" } },
      { user: { name: { contains: search, mode: "insensitive" } } },
    ];
  }

  const [orders, byMethod, byStatus, ledger] = await Promise.all([
    prisma.order.findMany({
      where,
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, orderCode: true, status: true, costPaise: true, paymentMethod: true,
        razorpayOrderId: true, razorpayPaymentId: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true } },
        printer: { select: { name: true, uniquePrinterId: true } },
      },
    }),
    prisma.order.groupBy({ by: ["paymentMethod"], _count: { _all: true }, _sum: { costPaise: true } }),
    prisma.order.groupBy({ by: ["status"], _count: { _all: true } }),
    prisma.pointsTransaction.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, type: true, amountPoints: true, balancePoints: true,
        amountPaise: true, balancePaise: true, description: true,
        razorpayId: true, orderId: true, createdAt: true,
        user: { select: { id: true, name: true } },
      },
    }),
  ]);

  const methodCount = (m: string) => byMethod.find((r) => r.paymentMethod === m);
  const statusCount = (s: string) => byStatus.find((r) => r.status === s)?._count._all ?? 0;

  res.json({
    total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
    upi: { count: methodCount("UPI")?._count._all ?? 0, revenuePaise: methodCount("UPI")?._sum.costPaise ?? 0 },
    points: { count: methodCount("POINTS")?._count._all ?? 0, revenuePaise: methodCount("POINTS")?._sum.costPaise ?? 0 },
    // A print that failed is money taken for nothing, so it's grouped with the
    // payment failures rather than hidden under order status.
    failed: statusCount("FAILED") + statusCount("CANCELLED"),
    pending: statusCount("PENDING_PAYMENT"),
    orders,
    ledger,
  });
});

// ── Refunds ──────────────────────────────────────────────────────────────────
financeRouter.get("/refunds", async (_req, res) => {
  const [refunds, totals, byReason, byOrigin] = await Promise.all([
    prisma.refund.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, amountPaise: true, pointsCredited: true, reason: true,
        origin: true, note: true, createdAt: true,
        user: { select: { id: true, name: true, phone: true } },
        order: { select: { id: true, orderCode: true, status: true } },
      },
    }),
    prisma.refund.aggregate({ _sum: { amountPaise: true, pointsCredited: true }, _count: { _all: true } }),
    prisma.refund.groupBy({ by: ["reason"], _count: { _all: true }, _sum: { amountPaise: true } }),
    prisma.refund.groupBy({ by: ["origin"], _count: { _all: true } }),
  ]);

  const completedRevenue = await prisma.order.aggregate({ _sum: { costPaise: true }, where: EARNED });
  const revenue = completedRevenue._sum.costPaise || 0;
  const refunded = totals._sum.amountPaise || 0;

  res.json({
    total: totals._count._all,
    totalPaise: refunded,
    totalPoints: totals._sum.pointsCredited || 0,
    automatic: byOrigin.find((r) => r.origin === "AUTOMATIC")?._count._all ?? 0,
    manual: byOrigin.find((r) => r.origin === "MANUAL")?._count._all ?? 0,
    /** Refunds as a share of what was earned — the number that matters. */
    refundRate: revenue > 0 ? Math.round((refunded / revenue) * 1000) / 10 : 0,
    byReason: byReason
      .map((r) => ({ reason: r.reason, count: r._count._all, amountPaise: r._sum.amountPaise || 0 }))
      .sort((a, b) => b.count - a.count),
    refunds,
  });
});

// ── Commissions ──────────────────────────────────────────────────────────────
// The rate lives in platform settings. At 0% every figure here is zero, and
// that is the truthful answer until somebody sets a real rate.
financeRouter.get("/commissions", async (_req, res) => {
  const settings = await readSettings();
  const rate = settings.pricing?.commissionPercent ?? 0;

  const [byVendor, vendors, total] = await Promise.all([
    settlementGrossByVendor(),
    prisma.vendor.findMany({ select: { id: true, shopName: true } }),
    settlementGross(),
  ]);

  const shopName = new Map(vendors.map((v) => [v.id, v.shopName]));
  const rows = Array.from(byVendor.entries())
    .map(([vendorId, g]) => {
      const gross = g.grossPaise;
      const commission = Math.round((gross * rate) / 100);
      return {
        vendorId,
        name: shopName.get(vendorId) || "Unknown shop",
        orders: g.orderCount,
        grossPaise: gross,
        commissionPaise: commission,
        vendorNetPaise: gross - commission,
      };
    })
    .sort((a, b) => b.grossPaise - a.grossPaise);

  const grossAll = total.grossPaise;

  res.json({
    ratePercent: rate,
    /** True when nobody has set a rate — the console explains rather than showing ₹0 as fact. */
    rateUnset: rate === 0,
    grossPaise: grossAll,
    platformEarningsPaise: Math.round((grossAll * rate) / 100),
    vendorNetPaise: grossAll - Math.round((grossAll * rate) / 100),
    orders: total.orderCount,
    byVendor: rows,
  });
});

// ── Payouts ──────────────────────────────────────────────────────────────────
financeRouter.get("/payouts", async (_req, res) => {
  const settings = await readSettings();
  const rate = settings.pricing?.commissionPercent ?? 0;

  const [payouts, byStatus, vendors, earned, paidOut] = await Promise.all([
    prisma.payout.findMany({
      orderBy: { createdAt: "desc" },
      take: 200,
      select: {
        id: true, grossPaise: true, commissionPaise: true, netPaise: true,
        periodStart: true, periodEnd: true, orderCount: true, status: true,
        reference: true, failureReason: true, note: true,
        processedAt: true, createdAt: true,
        vendor: {
          select: {
            id: true, shopName: true,
            user: { select: { name: true, bankAccount: { select: { accountHolder: true, accountNumber: true, ifsc: true, verified: true } } } },
          },
        },
      },
    }),
    prisma.payout.groupBy({ by: ["status"], _count: { _all: true }, _sum: { netPaise: true } }),
    prisma.vendor.findMany({
      select: {
        id: true, shopName: true,
        user: { select: { bankAccount: { select: { verified: true, accountNumber: true } } } },
      },
    }),
    settlementGrossByVendor(),
    prisma.payout.groupBy({ by: ["vendorId"], where: { status: "PAID" }, _sum: { grossPaise: true } }),
  ]);

  const earnedFor = earned;
  const paidFor = new Map(paidOut.map((r) => [r.vendorId, r._sum.grossPaise || 0]));

  // What each shop is owed: everything they have earned, less what has already
  // been paid out to them. Computed rather than stored, so it can't drift.
  const outstanding = vendors
    .map((v) => {
      const gross = earnedFor.get(v.id)?.grossPaise || 0;
      const already = paidFor.get(v.id) || 0;
      const pendingGross = Math.max(0, gross - already);
      const commission = Math.round((pendingGross * rate) / 100);
      return {
        vendorId: v.id,
        shopName: v.shopName,
        orders: earnedFor.get(v.id)?.orderCount || 0,
        earnedPaise: gross,
        alreadyPaidPaise: already,
        pendingGrossPaise: pendingGross,
        commissionPaise: commission,
        pendingNetPaise: pendingGross - commission,
        // A payout cannot responsibly be made to an unverified account.
        bankVerified: !!v.user?.bankAccount?.verified,
        hasBankAccount: !!v.user?.bankAccount,
      };
    })
    .filter((v) => v.pendingGrossPaise > 0 || v.alreadyPaidPaise > 0)
    .sort((a, b) => b.pendingNetPaise - a.pendingNetPaise);

  const statusCount = (s: string) => byStatus.find((r) => r.status === s);

  res.json({
    ratePercent: rate,
    total: byStatus.reduce((sum, r) => sum + r._count._all, 0),
    pending: statusCount("PENDING")?._count._all ?? 0,
    processing: statusCount("PROCESSING")?._count._all ?? 0,
    paid: statusCount("PAID")?._count._all ?? 0,
    failed: statusCount("FAILED")?._count._all ?? 0,
    paidPaise: statusCount("PAID")?._sum.netPaise ?? 0,
    outstandingPaise: outstanding.reduce((s, v) => s + v.pendingNetPaise, 0),
    outstanding,
    payouts: payouts.map((p) => ({
      ...p,
      // Masked, as everywhere else.
      accountMasked: p.vendor?.user?.bankAccount?.accountNumber
        ? `••••••${p.vendor.user.bankAccount.accountNumber.slice(-4)}`
        : null,
      accountHolder: p.vendor?.user?.bankAccount?.accountHolder || null,
      bankVerified: !!p.vendor?.user?.bankAccount?.verified,
    })),
  });
});

const createPayoutSchema = z.object({
  vendorId: z.string().min(1),
  note: z.string().trim().max(500).optional(),
});

/** Draw up a payout for everything a shop is currently owed. */
financeRouter.post("/payouts", async (req: AuthedRequest, res) => {
  const parsed = createPayoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Pick a vendor" });

  const settings = await readSettings();
  const rate = settings.pricing?.commissionPercent ?? 0;

  const vendor = await prisma.vendor.findUnique({
    where: { id: parsed.data.vendorId },
    select: { id: true, shopName: true, user: { select: { bankAccount: { select: { verified: true } } } } },
  });
  if (!vendor) return res.status(404).json({ error: "Vendor not found" });
  if (!vendor.user?.bankAccount) {
    return res.status(409).json({ error: "This shop has no payout account on file." });
  }
  if (!vendor.user.bankAccount.verified) {
    return res.status(409).json({ error: "This shop's bank account hasn't been verified yet." });
  }

  const [earned, paidAgg, firstOrder] = await Promise.all([
    vendorSettlementGross(vendor.id),
    prisma.payout.aggregate({ _sum: { grossPaise: true }, where: { vendorId: vendor.id, status: "PAID" } }),
    prisma.order.findFirst({ where: { ...EARNED, vendorId: vendor.id }, orderBy: { createdAt: "asc" }, select: { createdAt: true } }),
  ]);

  // Earned is net of the refunded portion of any partial print — the shop is
  // paid only for pages that actually came out.
  const gross = earned.grossPaise - (paidAgg._sum.grossPaise || 0);
  if (gross <= 0) {
    return res.status(409).json({ error: "Nothing outstanding for this shop." });
  }

  const commission = Math.round((gross * rate) / 100);
  const payout = await prisma.payout.create({
    data: {
      vendorId: vendor.id,
      grossPaise: gross,
      commissionPaise: commission,
      netPaise: gross - commission,
      periodStart: firstOrder?.createdAt || new Date(),
      periodEnd: new Date(),
      orderCount: earned.orderCount,
      note: parsed.data.note || null,
      createdById: req.user!.userId,
    },
  });

  res.status(201).json({ payout });
});

const updatePayoutSchema = z.object({
  status: z.enum(["PENDING", "PROCESSING", "PAID", "FAILED"]),
  reference: z.string().trim().max(160).optional(),
  failureReason: z.string().trim().max(500).optional(),
});

/** Move a payout along as the transfer is actually made. */
financeRouter.patch("/payouts/:id", async (req, res) => {
  const parsed = updatePayoutSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: "Invalid update" });
  const { status, reference, failureReason } = parsed.data;

  if (status === "PAID" && !reference?.trim()) {
    // Without a reference a "paid" payout can't be reconciled against a bank
    // statement, which is the only thing that proves it happened.
    return res.status(400).json({ error: "A transaction reference is required to mark a payout paid." });
  }

  const payout = await prisma.payout.update({
    where: { id: req.params.id },
    data: {
      status,
      reference: reference?.trim() || null,
      failureReason: status === "FAILED" ? failureReason?.trim() || null : null,
      processedAt: status === "PAID" ? new Date() : null,
    },
  });
  res.json({ payout });
});
