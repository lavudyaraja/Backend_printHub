// Support tickets a console user raises with the platform.
//
// The vendor console used to render the ADMIN-only triage list, which meant a
// shop owner either saw a 403 or — signed in as staff — every other shop's
// tickets. This is the other direction: a vendor opens a ticket with the
// operator and reads the replies on their own, and only their own.
//
// Triage stays where it belongs, on the admin portal's /admin/support.
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, type AuthedRequest } from "../middleware/authGuard";

export const supportRouter = Router();

const ticketSchema = z.object({
  subject: z.string().trim().min(4, "Give your request a subject").max(160),
  message: z.string().trim().min(10, "Describe the problem in a little more detail").max(4000),
});

/** The caller's own tickets, newest first. */
supportRouter.get("/me", requireAuth, async (req: AuthedRequest, res) => {
  const tickets = await prisma.supportTicket.findMany({
    where: { userId: req.user!.userId },
    orderBy: { createdAt: "desc" },
    take: 100,
    select: {
      id: true, subject: true, message: true, status: true,
      reply: true, createdAt: true, updatedAt: true,
    },
  });
  res.json({ tickets });
});

/** Raise a ticket with the operator. */
supportRouter.post("/me", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = ticketSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: parsed.error.errors[0]?.message || "Invalid request" });
  }

  // Name and email come from the account, not the form: they identify who is
  // asking, and a caller shouldn't be able to raise a ticket as someone else.
  const user = await prisma.user.findUnique({
    where: { id: req.user!.userId },
    select: { name: true, email: true, phone: true },
  });

  const ticket = await prisma.supportTicket.create({
    data: {
      userId: req.user!.userId,
      name: user?.name || "Console user",
      email: user?.email || user?.phone || "",
      subject: parsed.data.subject,
      message: parsed.data.message,
    },
    select: { id: true, subject: true, message: true, status: true, reply: true, createdAt: true, updatedAt: true },
  });

  res.status(201).json({ ticket });
});
