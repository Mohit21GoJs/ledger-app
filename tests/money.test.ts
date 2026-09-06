import { describe, expect, test } from "bun:test";
import { add } from "dinero.js/bigint";

import { AED, BHD, accrue, decimal, parseAmount, split } from "../src/money";

/**
 * These tests pin the three PROPERTIES this ledger depends on, not the library
 * that happens to provide them. dinero.js does the arithmetic; the invariants
 * below are the domain's, and they are what would break if the arithmetic were
 * ever swapped out.
 */

describe("parseAmount", () => {
  test("stores an amount at its currency's own precision", () => {
    expect(decimal(parseAmount(AED, "1200.00"))).toBe("1200.00");
    expect(decimal(parseAmount(BHD, "10.000"))).toBe("10.000");
  });

  test("pads an under-specified amount up to that precision", () => {
    expect(decimal(parseAmount(AED, "25"))).toBe("25.00");
    expect(decimal(parseAmount(BHD, "10.5"))).toBe("10.500");
  });

  /**
   * The invariant dinero.js does NOT enforce for us: it will happily hold an
   * AED amount at scale 3. Accepting "1.005" as AED would mean silently
   * deciding, at the boundary, which way to round someone's money. Rounding is
   * a named operation here, never a side effect of parsing.
   */
  test("refuses an amount finer than its currency can store", () => {
    expect(() => parseAmount(AED, "1.005")).toThrow(/precision/i);
    expect(() => parseAmount(BHD, "10.0001")).toThrow(/precision/i);
  });

  test("parses negative amounts", () => {
    expect(decimal(parseAmount(AED, "-370.00"))).toBe("-370.00");
  });

  test("refuses text that is not a decimal amount", () => {
    for (const bad of ["", "  ", "abc", "1.2.3", "1,200.00.", "--5", "1e3"]) {
      expect(() => parseAmount(AED, bad)).toThrow();
    }
  });

  test("refuses to combine currencies without an FX rate", () => {
    const aed = parseAmount(AED, "1.00");
    const bhd = parseAmount(BHD, "1.000");
    expect(() => add(aed, bhd as never)).toThrow(/currency/i);
  });
});

describe("accrue", () => {
  const daily = { amount: 4n, scale: 4n }; // 0.04% per day

  test("rounds to the currency's precision in a single step", () => {
    // 465.00 * 0.0004 = 0.186 exactly -> 0.19
    expect(decimal(accrue(parseAmount(AED, "465.00"), daily))).toBe("0.19");
    // 440.00 * 0.0004 = 0.176 exactly -> 0.18
    expect(decimal(accrue(parseAmount(AED, "440.00"), daily))).toBe("0.18");
  });

  test("leaves an exactly-representable accrual alone", () => {
    expect(decimal(accrue(parseAmount(AED, "250.00"), daily))).toBe("0.10");
    expect(decimal(accrue(parseAmount(AED, "650.00"), daily))).toBe("0.26");
    expect(decimal(accrue(parseAmount(BHD, "10.000"), daily))).toBe("0.004");
  });

  /**
   * Half-away-from-zero, not half-toward-positive: a positive and a negative
   * amount of the same magnitude must round to the same magnitude. Otherwise
   * the sign of a charge would decide its size, which is indefensible to a
   * customer.
   */
  test("rounds symmetrically about zero", () => {
    const positive = accrue(parseAmount(AED, "465.00"), daily);
    const negative = accrue(parseAmount(AED, "-465.00"), daily);
    expect(decimal(positive)).toBe("0.19");
    expect(decimal(negative)).toBe("-0.19");
  });
});

describe("split", () => {
  /**
   * The point of this function. Three EQUAL instalments of BHD 10.000 do not
   * exist; three instalments that sum to exactly 10.000 do. Conservation beats
   * equality, because a ledger that does not conserve is not a ledger.
   */
  test("conserves the total when it cannot be divided equally", () => {
    const instalments = split(parseAmount(BHD, "10.000"), 3);
    expect(instalments.map((i) => decimal(i))).toEqual(["3.334", "3.333", "3.333"]);
    expect(decimal(instalments.reduce(add))).toBe("10.000");
  });

  test("hands the remainder out from the front", () => {
    // An early share is never below its fair value, so a partially-applied
    // split can never under-credit the customer.
    const shares = split(parseAmount(AED, "10.00"), 3);
    expect(shares.map((s) => decimal(s))).toEqual(["3.34", "3.33", "3.33"]);
  });

  test("divides cleanly when it can", () => {
    expect(split(parseAmount(AED, "9.00"), 3).map((s) => decimal(s))).toEqual([
      "3.00",
      "3.00",
      "3.00",
    ]);
  });

  test("a split into one part is the original amount", () => {
    expect(split(parseAmount(BHD, "10.000"), 1).map((s) => decimal(s))).toEqual(["10.000"]);
  });

  test("refuses a non-positive or fractional number of parts", () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      expect(() => split(parseAmount(AED, "10.00"), bad)).toThrow(/parts/i);
    }
  });
});
