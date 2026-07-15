// =============================================================================
// format.js — PTO display conventions
// =============================================================================
// Overlay: bcc-premium-overlay v0.5.1-rc1
//
// Convention (established Phase 2, 2026-07-09):
//   * DATABASE stores PTO amounts in DAYS (pto_balances.balance_days,
//     pto_requests.total_days, pto_policies.accrual_rate_days, etc.). This
//     is the source of truth and where all math happens.
//   * UI displays PTO amounts in HOURS everywhere. Insurance agents and
//     their producers think in hours ("she has 40 hours") — never days.
//
// This module provides the conversion + formatting utilities. Every PTO
// JSX file that displays a balance, request duration, or accrual amount
// MUST use these helpers rather than hardcoding conversion. Consistency
// is the whole point.
//
// Standard conversion:
//   1 day = 8 hours (the industry-standard working day for salary/hourly
//   employees; the same convention Base's payroll uses)
//
// If an agency needs a different conversion (e.g., 7.5-hour days for
// office managers), that would be a future settings toggle. For v0.5.1-rc1
// we bake in 8-hour days as the single convention. Do not add per-user
// or per-role toggles without an explicit design decision — the whole
// point of the convention is that it's uniform.
// =============================================================================

/**
 * Hours-per-day conversion factor. Do not change without a design decision.
 */
export const HOURS_PER_DAY = 8;

/**
 * Convert a day amount to hours.
 * @param {number|null|undefined} days
 * @returns {number|null} hours, or null if input is null/undefined/NaN
 */
export function daysToHours(days) {
  if (days === null || days === undefined) return null;
  const n = Number(days);
  if (Number.isNaN(n)) return null;
  return n * HOURS_PER_DAY;
}

/**
 * Convert an hour amount back to days. Useful when accepting user input
 * in hours and needing to persist as days.
 * @param {number|null|undefined} hours
 * @returns {number|null} days
 */
export function hoursToDays(hours) {
  if (hours === null || hours === undefined) return null;
  const n = Number(hours);
  if (Number.isNaN(n)) return null;
  return n / HOURS_PER_DAY;
}

/**
 * Format a day amount for display as hours. The primary formatter every
 * PTO display should use.
 *
 * @param {number|null|undefined} days      value stored in DB (days)
 * @param {object} [opts]
 * @param {boolean} [opts.showUnit=true]    append " hrs" to the number
 * @param {number}  [opts.decimals=1]       decimal places (0-2)
 * @param {string}  [opts.emptyLabel="—"]   what to render when input is null
 * @returns {string}
 *
 * @example
 *   formatDaysAsHours(9)         // "72 hrs"
 *   formatDaysAsHours(1.5)       // "12 hrs"
 *   formatDaysAsHours(0.5)       // "4 hrs"
 *   formatDaysAsHours(0.77)      // "6.2 hrs"
 *   formatDaysAsHours(null)      // "—"
 */
export function formatDaysAsHours(days, opts = {}) {
  const { showUnit = true, decimals = 1, emptyLabel = "—" } = opts;
  const hrs = daysToHours(days);
  if (hrs === null) return emptyLabel;

  // Whole-number hours render without decimals for cleanliness.
  const rounded = Math.round(hrs * Math.pow(10, decimals)) / Math.pow(10, decimals);
  let str;
  if (Number.isInteger(rounded)) {
    str = String(rounded);
  } else {
    str = rounded.toFixed(decimals).replace(/\.?0+$/, "");
  }
  return showUnit ? `${str} hrs` : str;
}

/**
 * Format a day amount for display as days. Used only for accrual policy
 * definitions ("15 days/year") where days is the natural unit. For
 * balances, requests, and used-time displays, use formatDaysAsHours.
 */
export function formatDays(days, opts = {}) {
  const { showUnit = true, decimals = 2, emptyLabel = "—" } = opts;
  if (days === null || days === undefined) return emptyLabel;
  const n = Number(days);
  if (Number.isNaN(n)) return emptyLabel;
  const rounded = Math.round(n * Math.pow(10, decimals)) / Math.pow(10, decimals);
  let str;
  if (Number.isInteger(rounded)) {
    str = String(rounded);
  } else {
    str = rounded.toFixed(decimals).replace(/\.?0+$/, "");
  }
  return showUnit ? `${str} days` : str;
}

/**
 * Compute an "after approval" balance preview: the hours remaining after
 * a request is approved. Used by PTOAdmin's pending queue row display
 * per the design mockup ("Balance: 72 hrs -> After: 48 hrs").
 *
 * @example
 *   formatAfterBalance(9, 3)   // "48 hrs" (9 days = 72 hrs, minus 3 days = 24 hrs, so 48)
 */
export function formatAfterBalance(currentBalanceDays, requestDays) {
  if (currentBalanceDays === null || currentBalanceDays === undefined) return "—";
  if (requestDays === null || requestDays === undefined) return "—";
  const afterDays = Number(currentBalanceDays) - Number(requestDays);
  return formatDaysAsHours(afterDays);
}

/**
 * Compute the display label for a request's duration. Handles half-day
 * requests specially (renders "4 hrs" for is_half_day=true regardless of
 * date range).
 *
 * @example
 *   formatRequestDuration({ total_days: 3, is_half_day: false })   // "24 hrs"
 *   formatRequestDuration({ total_days: 0.5, is_half_day: true })  // "4 hrs (half day)"
 */
export function formatRequestDuration(request) {
  if (!request) return "—";
  const base = formatDaysAsHours(request.total_days);
  if (request.is_half_day) return `${base} (half day)`;
  return base;
}
