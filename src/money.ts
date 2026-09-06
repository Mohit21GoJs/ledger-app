/**
 * Money.
 *
 * dinero.js does the arithmetic, through its bigint entry point, so no float
 * ever touches a balance. This module adds the three things the domain needs
 * that a general-purpose money library does not give us:
 *
 *   parseAmount  a decimal string at EXACTLY the currency's precision, or an
 *                error. dinero will happily hold an AED amount at scale 3;
 *                this ledger will not.
 *   accrue       apply a rate and round back to the currency's precision in
 *                ONE step, so an interest figure is never rounded twice.
 *   split        divide an amount into shares that sum to exactly the original.
 *
 * Everything else -- add, subtract, compare, isNegative -- is dinero's and is
 * imported directly by the callers that need it. Re-exporting it here would add
 * a layer that only forwards.
 */

import {
  allocate,
  type Dinero,
  dinero,
  halfAwayFromZero,
  multiply,
  toDecimal,
  toSnapshot,
  transformScale,
} from "dinero.js/bigint";
import { AED, BHD } from "dinero.js/bigint/currencies";

export { AED, BHD };

/** The only two currencies this ledger knows. AED stores 2dp, BHD stores 3. */
export type LedgerCurrency = typeof AED | typeof BHD;

export type Money = Dinero<bigint, string>;

/**
 * A rate as an exact scaled integer: 0.04% per day is `{ amount: 4n, scale: 4n }`.
 * Kept exact so that rounding happens once, in `accrue`, where we choose it.
 */
export type Rate = { readonly amount: bigint; readonly scale: bigint };

/** The empty sum, in a given currency. An account with no postings is here. */
export function zero(currency: LedgerCurrency): Money {
  return dinero({ amount: 0n, currency });
}

/** No thousands separators, no exponent notation: an amount is digits and at most one point. */
const DECIMAL_AMOUNT = /^-?\d+(?:\.\d+)?$/;

function precisionOf(amount: Money): bigint {
  return toSnapshot(amount).currency.exponent;
}

/**
 * Parse a decimal string at exactly the currency's precision.
 *
 * Rejects rather than truncates. Accepting "1.005" as an AED amount would mean
 * silently deciding, at the boundary, which way to round someone's money.
 * Rounding is a named operation in this codebase, never a side effect of input.
 */
export function parseAmount(currency: LedgerCurrency, text: string): Money {
  const trimmed = text.trim();
  if (!DECIMAL_AMOUNT.test(trimmed)) {
    throw new Error(`not a decimal amount: ${JSON.stringify(text)}`);
  }

  const [whole = "", fraction = ""] = trimmed.replace("-", "").split(".");
  const precision = Number(currency.exponent);
  if (fraction.length > precision) {
    throw new Error(
      `precision: ${trimmed} has ${fraction.length} decimal places, ` +
        `${currency.code} stores ${precision}`,
    );
  }

  const magnitude =
    BigInt(whole) * 10n ** currency.exponent + BigInt(fraction.padEnd(precision, "0") || "0");

  return dinero({ amount: trimmed.startsWith("-") ? -magnitude : magnitude, currency });
}

/**
 * Apply a rate and round back to the currency's precision, in one step.
 *
 * `multiply` raises the scale rather than rounding, so the product is still
 * exact when `transformScale` rounds it. There is no intermediate to round
 * twice -- double rounding is the classic way an interest engine drifts away
 * from its own statement.
 *
 * Half-away-from-zero, so that a positive and a negative amount of the same
 * magnitude round to the same magnitude. Half-toward-positive would let the
 * sign of a charge decide its size.
 */
export function accrue(amount: Money, rate: Rate): Money {
  return transformScale(multiply(amount, rate), precisionOf(amount), halfAwayFromZero);
}

/**
 * Divide an amount into `parts` shares that sum to EXACTLY the original.
 *
 * Largest-remainder: every share gets the floor, then the leftover minor units
 * are handed out one at a time from the front. Front-loading is deliberate --
 * an early share is never below its fair value, so a partially-applied split
 * can never under-credit the customer.
 *
 * Conservation is the whole point. Three EQUAL instalments of BHD 10.000 do not
 * exist; three instalments that sum to 10.000 do.
 */
export function split(amount: Money, parts: number): Money[] {
  if (!Number.isInteger(parts) || parts < 1) {
    throw new Error(`parts must be a positive integer, got ${parts}`);
  }
  return allocate(
    amount,
    Array.from({ length: parts }, () => 1n),
  );
}

/**
 * The amount as a decimal string, at its own precision.
 *
 * Wrapping dinero's `toDecimal` is not ceremony: its second parameter is an
 * optional transformer, so the natural `amounts.map(toDecimal)` passes the
 * array index in as one and throws. This signature cannot be misused that way.
 */
export function decimal(amount: Money): string {
  return toDecimal(amount);
}

/** An amount with its currency code, for report lines. */
export function formatWithCode(amount: Money): string {
  return `${toSnapshot(amount).currency.code} ${decimal(amount)}`;
}
