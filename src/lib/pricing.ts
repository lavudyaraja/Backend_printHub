// Platform default page rates.
//
// A real order is priced from the printer it goes to — a shop sets its own
// per-page rates on its machines (Printer.costPerBWPagePaise and friends). These
// are the fallbacks used when an order has no printer yet, and the indicative
// figures the in-app cost calculator quotes from.
//
// They live here rather than inline so the schema defaults, the order pricing
// path and the calculator can't drift apart the way the points rate once did.

/** ₹2.00 per black-and-white page. Matches Printer.costPerBWPagePaise's default. */
export const DEFAULT_BW_PAGE_PAISE = 200;

/** ₹10.00 per colour page. Matches Printer.costPerColorPagePaise's default. */
export const DEFAULT_COLOR_PAGE_PAISE = 1000;

/** ₹1.00 per blank sheet — paper only, nothing imaged. */
export const BLANK_PAGE_PAISE = 100;
