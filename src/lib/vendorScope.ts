// Who owns what, for the vendor console.
//
// Printer routes used to be ADMIN-only, because a printer recorded its owner as
// free text and there was no way to ask "is this one yours?". Now that Printer
// has a vendorId, that question has an answer, and these helpers are where it
// gets asked.
import type { Response } from "express";
import { prisma } from "./prisma";
import type { AuthedRequest } from "../middleware/authGuard";

/** OPERATOR is the old name for VENDOR; both still appear on live rows. */
export function isVendorRole(role?: string): boolean {
  return role === "VENDOR" || role === "OPERATOR";
}

export function isAdminRole(role?: string): boolean {
  return role === "ADMIN";
}

/** The Vendor row for a signed-in vendor account, or null for anyone else. */
export async function vendorIdFor(userId: string): Promise<string | null> {
  const vendor = await prisma.vendor.findUnique({ where: { userId }, select: { id: true } });
  return vendor?.id ?? null;
}

/**
 * Resolve the caller's own vendor, replying 403 and returning null only when the
 * caller has no business in the vendor console at all. Callers should return
 * immediately on null.
 *
 * Both vendors and admins reach the vendor console — a vendor to run their shop,
 * an admin to look in and, often, because an admin runs a shop too. Either way
 * the per-shop pages act on the caller's *own* Vendor row, so both get one
 * resolved (and auto-created if missing). Creating a shop profile for your own
 * account is not a privileged act, and an admin operating their own shop in the
 * vendor console is the same shape as a vendor doing so — platform-wide views
 * live in the admin console, not here.
 *
 * Only a plain student (no console role) is turned away.
 */
export async function requireVendorId(req: AuthedRequest, res: Response): Promise<string | null> {
  const role = req.user?.role;
  if (!isVendorRole(role) && !isAdminRole(role)) {
    res.status(403).json({ error: "This is a vendor-only action." });
    return null;
  }

  const userId = req.user!.userId;
  const existing = await vendorIdFor(userId);
  if (existing) return existing;

  const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } });
  const created = await prisma.vendor.create({
    data: {
      userId,
      shopName: user?.name || "My shop",
      contactName: user?.name,
      mobileNumber: user?.phone,
    },
    select: { id: true },
  });
  return created.id;
}

/**
 * The caller's *own* vendor id, or null — without writing a 403.
 *
 * The difference from `requireVendorId` is that this never ends the response, so
 * a route can decide for itself what "you have no shop" should look like. A
 * VENDOR gets a profile auto-created (same reasoning as `requireVendorId`); an
 * ADMIN gets their own profile if they happen to run a shop, but nothing is
 * created for them — an admin poking at the vendor console is not a shop owner,
 * and a self-scoped page (like settlements) simply has nothing to show them.
 * Anyone else gets null.
 */
export async function ownVendorIdOrNull(req: AuthedRequest): Promise<string | null> {
  const userId = req.user?.userId;
  if (!userId) return null;

  if (isVendorRole(req.user?.role)) {
    const existing = await vendorIdFor(userId);
    if (existing) return existing;
    const user = await prisma.user.findUnique({ where: { id: userId }, select: { name: true, phone: true } });
    const created = await prisma.vendor.create({
      data: {
        userId,
        shopName: user?.name || "My shop",
        contactName: user?.name,
        mobileNumber: user?.phone,
      },
      select: { id: true },
    });
    return created.id;
  }

  // ADMIN or anyone else: only their own profile, never a fresh one.
  return vendorIdFor(userId);
}

/**
 * A `where` fragment that limits a query to what the caller may see: everything
 * for an admin, only their own for a vendor.
 */
export async function ownedPrinterFilter(req: AuthedRequest): Promise<{ vendorId?: string } | null> {
  if (isAdminRole(req.user?.role)) return {};
  if (!isVendorRole(req.user?.role)) return null; // not a console user
  const id = await vendorIdFor(req.user!.userId);
  // A vendor with no profile owns nothing — match no rows rather than all of them.
  return { vendorId: id ?? "__none__" };
}

/**
 * Check the caller may modify this printer. Replies 404 (not 403) when a vendor
 * reaches for someone else's machine — whether that id exists is not their
 * business.
 */
export async function assertCanManagePrinter(
  req: AuthedRequest,
  res: Response,
  printerId: string,
): Promise<boolean> {
  const printer = await prisma.printer.findUnique({
    where: { id: printerId },
    select: { vendorId: true },
  });
  if (!printer) {
    res.status(404).json({ error: "Printer not found" });
    return false;
  }
  if (isAdminRole(req.user?.role)) return true;

  const id = await vendorIdFor(req.user!.userId);
  if (!id || printer.vendorId !== id) {
    res.status(404).json({ error: "Printer not found" });
    return false;
  }
  return true;
}

/** Confirm a location belongs to this vendor before a printer is put in it. */
export async function locationBelongsToVendor(locationId: string, vendorId: string): Promise<boolean> {
  const loc = await prisma.location.findFirst({
    where: { id: locationId, vendorId },
    select: { id: true },
  });
  return !!loc;
}
