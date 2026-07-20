// Platform settings: a single JSON row in Neon (AppSettings id="app").
// Secrets (Razorpay secret, B2 app key) are stored but never returned raw — the
// API returns a masked placeholder + a `*Set` boolean, and only overwrites a
// secret when the client sends a new non-empty value.
import { prisma } from "./prisma";

export type Settings = {
  general: {
    platformName: string;
    supportEmail: string;
    supportPhone: string;
    companyLogoUrl: string;
    companyAddress: string;
    timezone: string;
    currency: string;
  };
  pricing: {
    bwPricePaise: number;
    colorPricePaise: number;
    minOrderPaise: number;
    gstPercent: number;
    extraChargesPaise: number;
    /// The platform's cut of a completed order, as a percent of the order total.
    /// Zero means the platform takes nothing, which is the honest default until
    /// someone sets a real rate.
    commissionPercent: number;
  };
  payments: {
    razorpayKeyId: string;
    razorpayKeySecret: string; // secret
    paymentsEnabled: boolean;
    refundsEnabled: boolean;
    refundWindowDays: number;
  };
  print: {
    allowedFileTypes: string[];
    maxFileSizeMb: number;
    maxPageLimit: number;
    duplexEnabled: boolean;
    colorEnabled: boolean;
  };
  notifications: {
    emailNotifications: boolean;
    orderCompletion: boolean;
    failedPaymentAlerts: boolean;
    adminNotifications: boolean;
  };
  branding: {
    appName: string;
    primaryColor: string;
    secondaryColor: string;
    logoUrl: string;
    footerText: string;
  };
  legal: {
    privacyPolicy: string;
    termsConditions: string;
    refundPolicy: string;
  };
};

export const DEFAULT_SETTINGS: Settings = {
  general: {
    platformName: "Prinsta",
    supportEmail: "",
    supportPhone: "",
    companyLogoUrl: "",
    companyAddress: "",
    timezone: "Asia/Kolkata",
    currency: "INR",
  },
  pricing: {
    bwPricePaise: 200,
    colorPricePaise: 1000,
    minOrderPaise: 0,
    commissionPercent: 0,
    gstPercent: 18,
    extraChargesPaise: 0,
  },
  payments: {
    razorpayKeyId: "",
    razorpayKeySecret: "",
    paymentsEnabled: false,
    refundsEnabled: true,
    refundWindowDays: 7,
  },
  print: {
    allowedFileTypes: ["PDF", "DOCX", "PPTX", "JPG", "PNG"],
    maxFileSizeMb: 25,
    maxPageLimit: 200,
    duplexEnabled: true,
    colorEnabled: true,
  },
  notifications: {
    emailNotifications: true,
    orderCompletion: true,
    failedPaymentAlerts: true,
    adminNotifications: true,
  },
  branding: {
    appName: "Prinsta",
    primaryColor: "#4f46e5",
    secondaryColor: "#7c3aed",
    logoUrl: "",
    footerText: "© Prinsta. All rights reserved.",
  },
  legal: {
    privacyPolicy: "",
    termsConditions: "",
    refundPolicy: "",
  },
};

// "section.field" paths whose value must never leave the server.
const SECRET_PATHS: Array<[keyof Settings, string]> = [
  ["payments", "razorpayKeySecret"],
];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

// Two-level deep merge (our settings shape is exactly section → field).
function mergeSettings(base: Settings, patch: unknown): Settings {
  const out: Settings = JSON.parse(JSON.stringify(base));
  if (!isObject(patch)) return out;
  for (const section of Object.keys(out) as (keyof Settings)[]) {
    const incoming = patch[section];
    if (isObject(incoming)) {
      Object.assign(out[section] as Record<string, unknown>, incoming);
    }
  }
  return out;
}

export async function readSettings(): Promise<Settings> {
  const row = await prisma.appSettings.findUnique({ where: { id: "app" } });
  return mergeSettings(DEFAULT_SETTINGS, row?.data ?? {});
}

// Public view: strip secret values, expose a `<field>Set` boolean instead.
export function maskSecrets(s: Settings): Settings & Record<string, unknown> {
  const clone = JSON.parse(JSON.stringify(s)) as Settings & Record<string, Record<string, unknown>>;
  for (const [section, field] of SECRET_PATHS) {
    const secTyped = clone[section] as Record<string, unknown>;
    const has = !!secTyped[field];
    secTyped[field] = "";
    secTyped[`${field}Set`] = has;
  }
  return clone;
}

export async function writeSettings(patch: unknown): Promise<Settings> {
  const current = await readSettings();
  // Drop empty secret fields from the patch so we never wipe a stored secret.
  if (isObject(patch)) {
    for (const [section, field] of SECRET_PATHS) {
      const sec = patch[section];
      if (isObject(sec) && (sec[field] === "" || sec[field] === undefined || sec[field] === null)) {
        delete sec[field];
      }
    }
  }
  const next = mergeSettings(current, patch);
  await prisma.appSettings.upsert({
    where: { id: "app" },
    create: { id: "app", data: next as object },
    update: { data: next as object },
  });
  return next;
}
