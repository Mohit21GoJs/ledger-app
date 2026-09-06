import { describe, expect, test } from "bun:test";
import { add } from "dinero.js/bigint";

import { ingest } from "../src/engine";
import type { CapitalizationEvent } from "../src/ledger";
import { decimal, zero } from "../src/money";
import { AED, BHD } from "../src/money";
import {
  ACC_AED,
  ACC_BHD,
  authorize,
  closeOf,
  closeThrough,
  credit,
  debit,
  eventsOfKind,
  newLedger,
  settle,
} from "./support";

describe("daily accrual", () => {
  test("accrues 0.04% of a positive closing balance", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "250.00", { on: 1 }));

    const [close] = closeThrough(ledger, 1);

    expect(decimal(closeOf(close, ACC_AED).interest)).toBe("0.10");
  });

  test("accrues nothing on a negative closing balance", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "100.00", { on: 1 }));

    const [close] = closeThrough(ledger, 1);

    expect(decimal(closeOf(close, ACC_AED).interest)).toBe("0.00");
  });

  test("accrues nothing on a closing balance of exactly zero", () => {
    const ledger = newLedger();

    const [close] = closeThrough(ledger, 1);

    expect(decimal(closeOf(close, ACC_AED).interest)).toBe("0.00");
  });

  /**
   * Interest accrues on the POST-fee close, because the fee is value-dated the
   * day assessed and is therefore part of what that day closed at.
   *
   * On any real stream this is unobservable, and deliberately so: a fee is only
   * assessed when the pre-fee balance is negative, and adding a charge to a
   * negative balance leaves it negative, so a fee day always accrues zero. The
   * ordering is pinned here because it is invisible -- an untested ordering
   * choice is where a second reader's numbers start diverging. See AMBIGUITIES
   * section 4.
   */
  test("a day that assessed a fee accrues nothing", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "100.00", { on: 1 }));

    const account = closeOf(closeThrough(ledger, 1)[0], ACC_AED);

    expect(decimal(account.fee!)).toBe("25.00");
    expect(decimal(account.closingBalance)).toBe("-125.00");
    expect(decimal(account.interest)).toBe("0.00");
  });

  /**
   * Accruals capitalize as a single credit at the end of Day 6, so they are not
   * part of the ledger balance on any earlier day and cannot form part of a
   * later day's base. Six simple accruals, no compounding.
   */
  test("does not compound inside the window", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "250.00", { on: 1 }));

    const closes = closeThrough(ledger, 2);

    // Day 1 accrued 0.10, but Day 2 still accrues on 250.00, not 250.10.
    expect(decimal(closeOf(closes[0], ACC_AED).interest)).toBe("0.10");
    expect(decimal(closeOf(closes[1], ACC_AED).closingBalance)).toBe("250.00");
    expect(decimal(closeOf(closes[1], ACC_AED).interest)).toBe("0.10");
  });

  test("rounds each day's accrual to the currency's own precision", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "465.00", { on: 1 }));
    ingest(ledger, credit("E10", "10.000", { on: 1 }, { accountId: ACC_BHD }));

    const [close] = closeThrough(ledger, 1);

    // 465.00 * 0.0004 = 0.186 -> 0.19 at 2dp
    expect(decimal(closeOf(close, ACC_AED).interest)).toBe("0.19");
    // 10.000 * 0.0004 = 0.004 exactly at 3dp
    expect(decimal(closeOf(close, ACC_BHD).interest)).toBe("0.004");
  });
});

describe("capitalization", () => {
  test("credits nothing before Day 6", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "250.00", { on: 1 }));

    closeThrough(ledger, 5);

    expect(eventsOfKind(ledger, "INTEREST_CAPITALIZATION")).toHaveLength(0);
  });

  test("credits once, at the end of Day 6", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "250.00", { on: 1 }));

    closeThrough(ledger, 6);

    const capitalizations = eventsOfKind(ledger, "INTEREST_CAPITALIZATION");
    expect(capitalizations).toHaveLength(1);
    expect(capitalizations[0]?.event.valueDate).toBe(6);
    expect(capitalizations[0]?.event.bookedDay).toBe(6);
  });

  /**
   * The non-negotiable rule: "The rounded daily accruals must sum exactly to
   * the capitalized total."
   *
   * It holds by construction rather than by reconciliation -- the credit IS the
   * sum of the stored daily amounts, so no remainder can exist to discard. This
   * is what makes acceptance criterion 8 refusable.
   */
  test("credits exactly the sum of the stored daily accruals", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "465.00", { on: 1 }));

    const closes = closeThrough(ledger, 6);
    const capitalized = closeOf(closes[5], ACC_AED).capitalized!;

    const daily = closes.map((close) => closeOf(close, ACC_AED).interest);
    expect(decimal(daily.reduce(add, zero(AED)))).toBe(decimal(capitalized));
  });

  test("carries its own components, so the credit is auditable", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "250.00", { on: 1 }));

    closeThrough(ledger, 6);
    const event = eventsOfKind(ledger, "INTEREST_CAPITALIZATION")[0]?.event as CapitalizationEvent;

    expect(event.accruals.map((accrual) => accrual.day)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(event.accruals.map((accrual) => decimal(accrual.amount))).toEqual([
      "0.10",
      "0.10",
      "0.10",
      "0.10",
      "0.10",
      "0.10",
    ]);
    expect(decimal(event.amount)).toBe("0.60");
  });

  test("credits nothing for an account that never accrued", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "100.00", { on: 1 }));

    closeThrough(ledger, 6);

    // Overdrawn throughout: there is no credit to make, so no event is booked.
    expect(eventsOfKind(ledger, "INTEREST_CAPITALIZATION")).toHaveLength(0);
  });

  test("does not compound: the Day-6 accrual precedes the credit", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "250.00", { on: 1 }));

    const closes = closeThrough(ledger, 6);
    const day6 = closeOf(closes[5], ACC_AED);

    // The Day-6 accrual read 250.00, not 250.50.
    expect(decimal(day6.closingBalance)).toBe("250.00");
    expect(decimal(day6.interest)).toBe("0.10");
    expect(decimal(day6.finalBalance)).toBe("250.60");
  });
});

describe("the supplied stream", () => {
  /**
   * ACC-001 across the real six days: 0.10 + 0.10 + 0.26 + 0.19 + 0.00 + 0.18.
   *
   * E9 stands in as a plain Day-6 credit valued Day 2, because reversal is not
   * implemented yet. That is exactly what a reversal of E7 posts, so the
   * accruals are the real ones. The genuine end-to-end replay, with the real
   * REVERSAL event, is pinned separately in `replay.test.ts`.
   */
  test("accrues 0.83 on ACC-001 and capitalizes it", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    const closes = [...closeThrough(ledger, 1)];

    ingest(ledger, authorize("E3", "Auth-A", "200.00", { on: 2 }));
    closes.push(...closeThrough(ledger, 2));

    ingest(ledger, credit("E4", "400.00", { on: 3 }));
    closes.push(...closeThrough(ledger, 3));

    ingest(ledger, settle("E5", "Auth-A", "185.00", { on: 4 }));
    closes.push(...closeThrough(ledger, 4));

    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));
    closes.push(...closeThrough(ledger, 5));

    ingest(ledger, credit("E9-as-reversal", "620.00", { on: 6, valued: 2 }));
    closes.push(...closeThrough(ledger, 6));

    expect(closes.map((close) => decimal(closeOf(close, ACC_AED).interest))).toEqual([
      "0.10",
      "0.10",
      "0.26",
      "0.19",
      "0.00",
      "0.18",
    ]);
    expect(decimal(closeOf(closes[5], ACC_AED).capitalized!)).toBe("0.83");
    expect(decimal(closeOf(closes[5], ACC_AED).finalBalance)).toBe("440.83");
  });

  /** ACC-002 holds BHD 10.000 from Day 5: 0.004 on Day 5 and again on Day 6. */
  test("accrues 0.008 on ACC-002 and capitalizes it", () => {
    const ledger = newLedger();
    closeThrough(ledger, 4);
    ingest(ledger, credit("E10", "10.000", { on: 5 }, { accountId: ACC_BHD, instalments: 3 }));
    const closes = closeThrough(ledger, 6);

    expect(closes.map((close) => decimal(closeOf(close, ACC_BHD).interest))).toEqual([
      "0.004",
      "0.004",
    ]);
    expect(decimal(closeOf(closes[1], ACC_BHD).capitalized!)).toBe("0.008");
    expect(decimal(closeOf(closes[1], ACC_BHD).finalBalance)).toBe("10.008");
  });

  test("keeps each currency at its own precision throughout", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, credit("E10", "10.000", { on: 1 }, { accountId: ACC_BHD }));

    const closes = closeThrough(ledger, 6);
    const day6 = closes[5];

    expect(decimal(closeOf(day6, ACC_AED).capitalized!)).toBe("2.88");
    expect(decimal(closeOf(day6, ACC_BHD).capitalized!)).toBe("0.024");
    expect(BHD.exponent).toBe(3n);
    expect(AED.exponent).toBe(2n);
  });
});
