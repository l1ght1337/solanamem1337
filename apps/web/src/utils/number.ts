// utils/number.ts - Number parsing and formatting utilities

/**
 * Parses a string or number, handling both comma and dot as decimal separators
 * @param v - Input value (string or number)
 * @returns Parsed number
 */
export function parseLocaleNumber(v: string | number): number {
  if (typeof v === "number") return v;
  // Remove spaces and replace comma with dot for consistent parsing
  return Number(v.replace(/\s/g, "").replace(",", "."));
}

/**
 * Formats a number to fixed decimal places or returns zero if not finite
 * @param n - Number to format
 * @param d - Decimal places (default: 5)
 * @returns Formatted number string
 */
export function toFixedOrZero(n?: number, d = 5): string {
  return Number.isFinite(n!) ? n!.toFixed(d) : "0".padEnd(d + 2, "0");
}

/**
 * Safe number parsing with fallback
 * @param value - Value to parse
 * @param fallback - Fallback value if parsing fails
 * @returns Parsed number or fallback
 */
export function safeParseNumber(value: any, fallback = 0): number {
  const parsed = parseLocaleNumber(value);
  return Number.isFinite(parsed) ? parsed : fallback;
}

/**
 * Safe addition that handles NaN values
 * @param a - First number
 * @param b - Second number
 * @returns Sum or 0 if either is NaN
 */
export function safeAdd(a: number, b: number): number {
  const result = a + b;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Safe multiplication that handles NaN values
 * @param a - First number
 * @param b - Second number
 * @returns Product or 0 if either is NaN
 */
export function safeMultiply(a: number, b: number): number {
  const result = a * b;
  return Number.isFinite(result) ? result : 0;
}

/**
 * Safe division that handles NaN and zero division
 * @param a - Numerator
 * @param b - Denominator
 * @returns Quotient or 0 if invalid
 */
export function safeDivide(a: number, b: number): number {
  if (!Number.isFinite(a) || !Number.isFinite(b) || b === 0) return 0;
  const result = a / b;
  return Number.isFinite(result) ? result : 0;
}