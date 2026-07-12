// Wallet — prepaid balance for faster print payments.
// Endpoints:
//   GET  /api/wallet               -> balance + recent transactions
//   POST /api/wallet/topup         -> initiate top-up (creates Razorpay/Mock Order)
//   GET  /api/wallet/checkout      -> renders HTML checkout page for WebView
//   POST /api/wallet/verify        -> verifies signature & credits wallet balance
//
import { Router } from "express";
import { z } from "zod";
import { prisma } from "../lib/prisma";
import { requireAuth, AuthedRequest } from "../middleware/authGuard";
import { verifyToken } from "../lib/auth";
import Razorpay from "razorpay";
import crypto from "crypto";
import { nanoid } from "nanoid";

export const walletRouter = Router();

const MIN_TOPUP = 1000; // ₹10
const MAX_TOPUP = 10_00_000; // ₹1,00,000

// Initialize Razorpay client only if keys are configured.
const rzpKeyId = process.env.RAZORPAY_KEY_ID || "";
const rzpKeySecret = process.env.RAZORPAY_KEY_SECRET || "";
const isRazorpayConfigured = rzpKeyId && rzpKeySecret;

let razorpay: Razorpay | null = null;
if (isRazorpayConfigured) {
  razorpay = new Razorpay({
    key_id: rzpKeyId,
    key_secret: rzpKeySecret,
  });
}

// Get balance + recent transactions.
walletRouter.get("/", requireAuth, async (req: AuthedRequest, res) => {
  const [user, txns] = await Promise.all([
    prisma.user.findUnique({ where: { id: req.user!.userId }, select: { walletBalancePaise: true } }),
    prisma.walletTransaction.findMany({
      where: { userId: req.user!.userId },
      orderBy: { createdAt: "desc" },
      take: 50,
    }),
  ]);
  res.json({ balancePaise: user?.walletBalancePaise ?? 0, transactions: txns });
});

// Top up initiation schema.
const topupSchema = z.object({ amountPaise: z.number().int().min(MIN_TOPUP).max(MAX_TOPUP) });

// Initiate top-up order.
walletRouter.post("/topup", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = topupSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ error: `Enter an amount between ₹${MIN_TOPUP / 100} and ₹${MAX_TOPUP / 100}` });
  }
  const { amountPaise } = parsed.data;

  try {
    if (isRazorpayConfigured && razorpay) {
      // Create a real one-time Razorpay Order
      const order = await razorpay.orders.create({
        amount: amountPaise,
        currency: "INR",
        receipt: `topup_${req.user!.userId.substring(0, 8)}_${Date.now()}`,
      });
      return res.json({
        mode: "LIVE",
        razorpayOrderId: order.id,
        amountPaise,
        razorpayKeyId: rzpKeyId,
      });
    } else {
      // Create a Mock order for Sandbox/Simulation mode
      return res.json({
        mode: "SANDBOX",
        razorpayOrderId: `pay_mock_${nanoid(12)}`,
        amountPaise,
        razorpayKeyId: "rzp_test_mock_keys",
      });
    }
  } catch (error: any) {
    console.error("[wallet] Topup initiation failed:", error);
    return res.status(500).json({ error: "Failed to initiate payment gateway order." });
  }
});

// GET /api/wallet/checkout
// Renders the HTML page for the React Native WebView.
walletRouter.get("/checkout", async (req, res) => {
  const { orderId, amountPaise, token, mode } = req.query as {
    orderId: string;
    amountPaise: string;
    token: string;
    mode: "LIVE" | "SANDBOX";
  };

  if (!orderId || !amountPaise || !token || !mode) {
    return res.status(400).send("<h3>Invalid checkout request parameters.</h3>");
  }

  // Verify JWT user auth token
  let userId = "";
  try {
    const payload = verifyToken(token);
    userId = payload.userId;
  } catch (e) {
    return res.status(401).send("<h3>Unauthorized: Invalid checkout session.</h3>");
  }

  const numericAmount = parseInt(amountPaise, 10);
  const formattedAmount = (numericAmount / 100).toFixed(2);

  // Render a beautifully designed checkout interface (incorporating Razorpay SDK for live, and custom mockup for sandbox).
  res.setHeader("Content-Type", "text/html");
  res.send(`
<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Prinsta Secure Pay</title>
  <link href="https://fonts.googleapis.com/css2?family=Plus+Jakarta+Sans:wght@400;500;600;700;800&display=swap" rel="stylesheet">
  <script src="https://checkout.razorpay.com/v1/checkout.js"></script>
  <style>
    :root {
      --primary: #523AEF;
      --bg: #0B0E17;
      --surface: #151A29;
      --border: rgba(255, 255, 255, 0.08);
      --text: #F3F4F6;
      --text-muted: #9CA3AF;
      --success: #10B981;
      --error: #EF4444;
    }
    * {
      box-sizing: border-box;
      margin: 0;
      padding: 0;
      font-family: 'Plus Jakarta Sans', sans-serif;
    }
    body {
      background-color: var(--bg);
      color: var(--text);
      display: flex;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      min-height: 100vh;
      padding: 20px;
      overflow: hidden;
    }
    .container {
      width: 100%;
      max-width: 440px;
      background: rgba(21, 26, 41, 0.6);
      backdrop-filter: blur(16px);
      border: 1px solid var(--border);
      border-radius: 24px;
      padding: 28px;
      box-shadow: 0 20px 40px rgba(0,0,0,0.4);
      display: flex;
      flex-direction: column;
      gap: 24px;
      animation: fadeIn 0.4s ease-out;
    }
    @keyframes fadeIn {
      from { opacity: 0; transform: translateY(12px); }
      to { opacity: 1; transform: translateY(0); }
    }
    .header {
      display: flex;
      justify-content: space-between;
      align-items: center;
      border-bottom: 1px solid var(--border);
      padding-bottom: 20px;
    }
    .brand-title {
      font-weight: 800;
      font-size: 18px;
      color: #FFF;
      letter-spacing: -0.5px;
    }
    .brand-subtitle {
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 2px;
    }
    .amount-display {
      text-align: right;
    }
    .amount-val {
      font-size: 22px;
      font-weight: 800;
      color: var(--primary);
    }
    .mode-badge {
      font-size: 9px;
      font-weight: 800;
      color: var(--success);
      background: rgba(16, 185, 129, 0.1);
      padding: 2px 6px;
      border-radius: 12px;
      display: inline-block;
      margin-top: 4px;
      text-transform: uppercase;
    }
    .mode-badge.sandbox {
      color: #FBBF24;
      background: rgba(251, 191, 36, 0.1);
    }
    .btn {
      background: var(--primary);
      color: white;
      border: none;
      border-radius: 14px;
      padding: 16px;
      font-weight: 700;
      font-size: 15px;
      cursor: pointer;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 10px;
      transition: all 0.2s ease;
      width: 100%;
    }
    .btn:active {
      transform: scale(0.98);
      filter: brightness(0.9);
    }
    .btn-secondary {
      background: rgba(255,255,255,0.05);
      border: 1px solid var(--border);
      color: var(--text-muted);
    }
    .status-view {
      display: none;
      flex-direction: column;
      align-items: center;
      justify-content: center;
      text-align: center;
      gap: 16px;
      padding: 20px 0;
    }
    .spinner {
      width: 48px;
      height: 48px;
      border: 4px solid rgba(255, 255, 255, 0.1);
      border-top-color: var(--primary);
      border-radius: 50%;
      animation: spin 0.8s linear infinite;
    }
    @keyframes spin {
      to { transform: rotate(360deg); }
    }
    .icon-circle {
      width: 72px;
      height: 72px;
      border-radius: 50%;
      display: flex;
      align-items: center;
      justify-content: center;
      font-size: 32px;
    }
    .icon-circle.success {
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
    }
    .icon-circle.error {
      background: rgba(239, 68, 68, 0.15);
      color: var(--error);
    }
    .status-title {
      font-size: 18px;
      font-weight: 800;
    }
    .status-desc {
      font-size: 13px;
      color: var(--text-muted);
      line-height: 1.5;
    }
    /* Sandbox Form Styles */
    .sandbox-form {
      display: flex;
      flex-direction: column;
      gap: 16px;
    }
    .form-group {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .form-group label {
      font-size: 12px;
      font-weight: 600;
      color: var(--text-muted);
    }
    .input-field {
      background: rgba(255,255,255,0.03);
      border: 1px solid var(--border);
      border-radius: 12px;
      padding: 14px;
      font-size: 14px;
      color: #FFF;
      outline: none;
      transition: border-color 0.2s;
    }
    .input-field:focus {
      border-color: var(--primary);
    }
    .sandbox-toggle {
      display: flex;
      border: 1px solid var(--border);
      border-radius: 10px;
      overflow: hidden;
      margin-bottom: 4px;
    }
    .toggle-opt {
      flex: 1;
      padding: 10px;
      font-size: 12px;
      font-weight: 700;
      text-align: center;
      background: rgba(255,255,255,0.02);
      cursor: pointer;
      color: var(--text-muted);
      transition: all 0.2s;
    }
    .toggle-opt.active.success {
      background: var(--success);
      color: white;
    }
    .toggle-opt.active.failure {
      background: var(--error);
      color: white;
    }
    .lock-footer {
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 6px;
      font-size: 11px;
      color: var(--text-muted);
      margin-top: 10px;
    }
  </style>
</head>
<body>

  <div class="container" id="main-card">
    <div class="header">
      <div>
        <div class="brand-title">Prinsta Secure Pay</div>
        <div class="brand-subtitle">One-time Wallet Recharge</div>
      </div>
      <div class="amount-display">
        <div class="amount-val">₹${formattedAmount}</div>
        <div class="mode-badge ${mode === "SANDBOX" ? "sandbox" : ""}">${mode} MODE</div>
      </div>
    </div>

    <!-- Live Checkout Content -->
    <div id="live-content" style="display: ${mode === "LIVE" ? "block" : "none"};">
      <p style="font-size: 14px; color: var(--text-muted); line-height: 1.6; margin-bottom: 24px;">
        Click the button below to complete your one-time payment securely via Razorpay. UPI, cards, and net banking are accepted.
      </p>
      <button class="btn" id="start-payment-btn" onclick="startRazorpayPayment()">
        Proceed to Pay ₹${formattedAmount}
      </button>
    </div>

    <!-- Sandbox Simulation Content -->
    <div id="sandbox-content" style="display: ${mode === "SANDBOX" ? "block" : "none"};">
      <div class="sandbox-form">
        <div class="form-group">
          <label>Simulation Result</label>
          <div class="sandbox-toggle">
            <div class="toggle-opt active success" id="sim-success-btn" onclick="setSimulate(true)">Success</div>
            <div class="toggle-opt" id="sim-failure-btn" onclick="setSimulate(false)">Failure</div>
          </div>
        </div>
        <div class="form-group">
          <label>UPI ID or Bank Account Details (Mock)</label>
          <input type="text" class="input-field" placeholder="e.g. mobile@upi" value="test-bank@upi">
        </div>
        <button class="btn" onclick="handleSandboxPayment()">
          Pay Securely (Mock)
        </button>
      </div>
    </div>

    <button class="btn btn-secondary" onclick="cancelPayment()">Cancel Transaction</button>

    <div class="lock-footer">
      <svg style="width: 12px; height: 12px; fill: currentColor;" viewBox="0 0 24 24"><path d="M12 17c1.1 0 2-.9 2-2s-.9-2-2-2-2 .9-2 2 .9 2 2 2zm6-9h-1V6c0-2.76-2.24-5-5-5S7 3.24 7 6v2H6c-1.1 0-2 .9-2 2v10c0 1.1.9 2 2 2h12c1.1 0 2-.9 2-2V10c0-1.1-.9-2-2-2zm-6-5c1.66 0 3 1.34 3 3v2H9V6c0-1.66 1.34-3 3-3zm6 15H6V10h12v10z"/></svg>
      Secured with SSL encryption
    </div>
  </div>

  <!-- Status Screens -->
  <div class="container" id="status-card" style="display: none;">
    <div class="status-view" id="status-processing">
      <div class="spinner"></div>
      <div class="status-title">Processing Payment...</div>
      <div class="status-desc">Validating with your bank. Do not close or refresh this page.</div>
    </div>

    <div class="status-view" id="status-success" style="display: none;">
      <div class="icon-circle success">✓</div>
      <div class="status-title" style="color: var(--success)">Payment Successful</div>
      <div class="status-desc">₹${formattedAmount} has been credited to your wallet.<br>Redirecting back to app...</div>
    </div>

    <div class="status-view" id="status-error" style="display: none;">
      <div class="icon-circle error">✕</div>
      <div class="status-title" style="color: var(--error)">Payment Failed</div>
      <div class="status-desc" id="error-message">The bank transaction was cancelled or declined.</div>
      <button class="btn" style="margin-top: 12px;" onclick="resetCheckout()">Try Again</button>
    </div>
  </div>

  <script>
    const orderId = "${orderId}";
    const amountPaise = ${numericAmount};
    const token = "${token}";
    const isLive = "${mode}" === "LIVE";
    let simulateSuccess = true;

    // Communication with React Native WebView
    function notifyMobile(payload) {
      if (window.ReactNativeWebView) {
        window.ReactNativeWebView.postMessage(JSON.stringify(payload));
      } else {
        console.log("PostMessage to Mobile:", payload);
      }
    }

    function cancelPayment() {
      notifyMobile({ status: 'cancelled' });
    }

    // Toggle simulation success/failure
    function setSimulate(success) {
      simulateSuccess = success;
      document.getElementById('sim-success-btn').className = success ? 'toggle-opt active success' : 'toggle-opt';
      document.getElementById('sim-failure-btn').className = !success ? 'toggle-opt active failure' : 'toggle-opt';
    }

    function showStatusCard(type) {
      document.getElementById('main-card').style.display = 'none';
      document.getElementById('status-card').style.display = 'flex';
      document.getElementById('status-processing').style.display = type === 'processing' ? 'flex' : 'none';
      document.getElementById('status-success').style.display = type === 'success' ? 'flex' : 'none';
      document.getElementById('status-error').style.display = type === 'error' ? 'flex' : 'none';
    }

    function resetCheckout() {
      document.getElementById('main-card').style.display = 'flex';
      document.getElementById('status-card').style.display = 'none';
    }

    // Handlers
    function startRazorpayPayment() {
      const options = {
        key: "${mode === "LIVE" ? rzpKeyId : ""}",
        amount: amountPaise,
        currency: "INR",
        name: "Prinsta",
        description: "Prepaid Print Wallet Top-up",
        order_id: orderId,
        handler: function (response) {
          verifyPaymentOnBackend({
            razorpayOrderId: response.razorpay_order_id,
            razorpayPaymentId: response.razorpay_payment_id,
            razorpaySignature: response.razorpay_signature,
            amountPaise: amountPaise
          });
        },
        modal: {
          ondismiss: function() {
            notifyMobile({ status: 'cancelled' });
          }
        },
        theme: { color: "#523AEF" }
      };
      
      const rzp = new Razorpay(options);
      rzp.open();
    }

    function handleSandboxPayment() {
      showStatusCard('processing');
      setTimeout(() => {
        if (simulateSuccess) {
          verifyPaymentOnBackend({
            razorpayOrderId: orderId,
            razorpayPaymentId: "pay_mock_" + Math.random().toString(36).substr(2, 9),
            razorpaySignature: "mock_signature_verified",
            amountPaise: amountPaise
          });
        } else {
          document.getElementById('error-message').innerText = "The sandbox payment transaction was declined by the simulated bank.";
          showStatusCard('error');
        }
      }, 1500);
    }

    function verifyPaymentOnBackend(body) {
      showStatusCard('processing');
      fetch('/api/wallet/verify', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + token
        },
        body: JSON.stringify(body)
      })
      .then(res => res.json())
      .then(data => {
        if (data.error) {
          document.getElementById('error-message').innerText = data.error;
          showStatusCard('error');
        } else {
          showStatusCard('success');
          setTimeout(() => {
            notifyMobile({ status: 'success', balancePaise: data.balancePaise });
          }, 1500);
        }
      })
      .catch(err => {
        document.getElementById('error-message').innerText = "Network error. Failed to verify payment.";
        showStatusCard('error');
      });
    }

    // Auto-trigger Razorpay checkout on live load
    if (isLive) {
      setTimeout(startRazorpayPayment, 200);
    }
  </script>
</body>
</html>
  `);
});

// Verify signature and credit wallet balance.
const verifySchema = z.object({
  razorpayOrderId: z.string(),
  razorpayPaymentId: z.string(),
  razorpaySignature: z.string(),
  amountPaise: z.number().int(),
});

walletRouter.post("/verify", requireAuth, async (req: AuthedRequest, res) => {
  const parsed = verifySchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ error: parsed.error.flatten() });

  const { razorpayOrderId, razorpayPaymentId, razorpaySignature, amountPaise } = parsed.data;

  // Verify Signature
  if (isRazorpayConfigured) {
    const hmac = crypto.createHmac("sha256", rzpKeySecret);
    hmac.update(razorpayOrderId + "|" + razorpayPaymentId);
    const generatedSignature = hmac.digest("hex");

    if (generatedSignature !== razorpaySignature) {
      return res.status(400).json({ error: "Payment verification failed. Invalid signature." });
    }
  } else {
    // Sandbox validation
    if (razorpaySignature !== "mock_signature_verified") {
      return res.status(400).json({ error: "Sandbox signature verification failed." });
    }
  }

  // Atomically credit the wallet.
  try {
    const result = await creditWallet(
      req.user!.userId,
      amountPaise,
      `Wallet top-up (Ref: ${razorpayPaymentId})`
    );
    return res.json({ balancePaise: result.balancePaise, transaction: result.txn });
  } catch (error: any) {
    console.error("[wallet] Failed to credit wallet after payment:", error);
    return res.status(500).json({ error: "Failed to credit balance to your wallet." });
  }
});

// ── Shared helpers (also used by the order flow) ─────────────────────

// Add money to a wallet atomically and record a CREDIT transaction.
export async function creditWallet(userId: string, amountPaise: number, description: string, orderId?: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.update({
      where: { id: userId },
      data: { walletBalancePaise: { increment: amountPaise } },
      select: { walletBalancePaise: true },
    });
    const txn = await tx.walletTransaction.create({
      data: {
        userId,
        type: "CREDIT",
        amountPaise,
        balancePaise: user.walletBalancePaise,
        description,
        orderId: orderId || null,
      },
    });
    return { balancePaise: user.walletBalancePaise, txn };
  });
}

// Spend from a wallet atomically. Throws "INSUFFICIENT_FUNDS" if the balance is
// too low, so callers can prompt the user to top up.
export async function debitWallet(userId: string, amountPaise: number, description: string, orderId?: string) {
  return prisma.$transaction(async (tx) => {
    const user = await tx.user.findUnique({ where: { id: userId }, select: { walletBalancePaise: true } });
    if (!user || user.walletBalancePaise < amountPaise) {
      throw new Error("INSUFFICIENT_FUNDS");
    }
    const updated = await tx.user.update({
      where: { id: userId },
      data: { walletBalancePaise: { decrement: amountPaise } },
      select: { walletBalancePaise: true },
    });
    const txn = await tx.walletTransaction.create({
      data: {
        userId,
        type: "DEBIT",
        amountPaise,
        balancePaise: updated.walletBalancePaise,
        description,
        orderId: orderId || null,
      },
    });
    return { balancePaise: updated.walletBalancePaise, txn };
  });
}
