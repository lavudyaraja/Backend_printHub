// What a vendor is owed, computed off orders — the single source of truth for
// every settlement figure now that payments are collected to the platform and
// settled by payout rather than split at capture.
//
// A completed order settles its `settlementPaise` to the shop: the full cost for
// a clean print, or the printed portion for one that was interrupted (the rest
// having been refunded to the customer as Points). `settlementPaise` is null on
// clean and older orders, where it simply means "the whole cost" — so gross is
//
//     Σ costPaise  −  Σ (costPaise − settlementPaise) over partial orders
//
// which avoids a per-row COALESCE the Prisma aggregate API can't express.
import { prisma } from "./prisma";
import type { Prisma } from "@prisma/client";

const COMPLETED = { status: "COMPLETED" as const };

export interface Gross {
  grossPaise: number;
  orderCount: number;
}

/** Settlement gross for any order filter (defaults to all completed orders). */
export async function settlementGross(
  where: Prisma.OrderWhereInput = {}
): Promise<Gross> {
  const scope = { ...COMPLETED, ...where };
  const [agg, partials] = await Promise.all([
    prisma.order.aggregate({ where: scope, _sum: { costPaise: true }, _count: { _all: true } }),
    prisma.order.findMany({
      where: { ...scope, settlementPaise: { not: null } },
      select: { costPaise: true, settlementPaise: true },
    }),
  ]);
  const cost = agg._sum.costPaise || 0;
  const reduction = partials.reduce(
    (sum, o) => sum + (o.costPaise - (o.settlementPaise ?? o.costPaise)),
    0
  );
  return { grossPaise: cost - reduction, orderCount: agg._count._all };
}

/** Convenience wrapper: one shop's settlement gross across its completed orders. */
export function vendorSettlementGross(vendorId: string): Promise<Gross> {
  return settlementGross({ vendorId });
}

/**
 * Settlement gross per vendor, for the platform's payout ledger. Returns a map
 * of vendorId → gross paise, already net of the refunded portion of any partial
 * print.
 */
export async function settlementGrossByVendor(
  where: Prisma.OrderWhereInput = {}
): Promise<Map<string, Gross>> {
  const scope = { ...COMPLETED, ...where };
  const [grouped, partials] = await Promise.all([
    prisma.order.groupBy({
      by: ["vendorId"],
      where: scope,
      _sum: { costPaise: true },
      _count: { _all: true },
    }),
    prisma.order.findMany({
      where: { ...scope, settlementPaise: { not: null } },
      select: { vendorId: true, costPaise: true, settlementPaise: true },
    }),
  ]);

  const reductionByVendor = new Map<string, number>();
  for (const o of partials) {
    if (!o.vendorId) continue;
    const cut = o.costPaise - (o.settlementPaise ?? o.costPaise);
    reductionByVendor.set(o.vendorId, (reductionByVendor.get(o.vendorId) || 0) + cut);
  }

  const out = new Map<string, Gross>();
  for (const g of grouped) {
    if (!g.vendorId) continue;
    const cost = g._sum.costPaise || 0;
    out.set(g.vendorId, {
      grossPaise: cost - (reductionByVendor.get(g.vendorId) || 0),
      orderCount: g._count._all,
    });
  }
  return out;
}
