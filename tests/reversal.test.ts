import { describe, expect, test } from "bun:test";

import { holdsOn, ingest } from "../src/engine";
import { decimal } from "../src/money";
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
  reverse,
  settle,
} from "./support";

describe("reversal", () => {
  test("negates the postings of its target", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    ingest(ledger, debit("E7", "620.00", { on: 1 }));

    const record = ingest(ledger, reverse("E9", "E7", { on: 2, valued: 1 }));

    expect(record.decision).toBe("APPLIED");
    expect(record.postings.map((p) => decimal(p.amount))).toEqual(["620.00"]);
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 2))).toBe("1000.00");
  });

  /**
   * The postings take the TARGET's value date, not the day the reversal was
   * booked. E9 is booked on Day 6 and undoes a Day-2-valued debit, so the money
   * is restored to Day 2 -- see AMBIGUITIES section 9.
   */
  test("posts at the target's value date, booked on its own day", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));

    const record = ingest(ledger, reverse("E9", "E7", { on: 6, valued: 2 }));

    expect(record.postings.map((p) => p.valueDate)).toEqual([2]);
    expect(record.postings.map((p) => p.bookedDay)).toEqual([6]);
    // Restated Day 2, knowing everything through Day 6, is back to 1200.00.
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 6))).toBe("1200.00");
  });

  test("leaves its target in the record log, untouched", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    const target = ingest(ledger, debit("E7", "620.00", { on: 1 }));
    ingest(ledger, reverse("E9", "E7", { on: 2, valued: 1 }));

    const stored = ledger.records.find((record) => record.event.id === "E7");
    expect(stored).toBe(target);
    expect(stored?.decision).toBe("APPLIED");
    expect(stored?.postings.map((p) => decimal(p.amount))).toEqual(["-620.00"]);
  });

  test("negates every posting of a multi-instalment target", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E10", "10.000", { on: 1 }, { accountId: ACC_BHD, instalments: 3 }));

    const record = ledger.records[0];
    expect(record?.postings).toHaveLength(3);

    const reversal = ingest(ledger, {
      kind: "REVERSAL",
      id: "R10",
      accountId: ACC_BHD,
      bookedDay: 2,
      valueDate: 1,
      reverses: "E10",
    });

    expect(reversal.postings.map((p) => decimal(p.amount))).toEqual([
      "-3.334",
      "-3.333",
      "-3.333",
    ]);
    expect(decimal(ledger.balanceAsOf(ACC_BHD, 2, 2))).toBe("0.000");
  });
});

describe("what a reversal does not undo", () => {
  /**
   * Acceptance criterion 6 claims that after E9 "all balances and fees return
   * to their pre-E7 values". They do not, and this is the test that refutes it.
   *
   * The Day-4 close was 465.00. E7 arrives on Day 5, is assessed a fee, and the
   * day closes at -180.00. E9 restores the 620.00 but not the 25.00: reversing
   * a debit is not authority to reverse a separately assessed charge, which was
   * correctly raised against what was known at the Day-5 close.
   */
  test("does not reverse a fee that its target caused", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    closeThrough(ledger, 1);
    ingest(ledger, authorize("E3", "Auth-A", "200.00", { on: 2 }));
    closeThrough(ledger, 2);
    ingest(ledger, credit("E4", "400.00", { on: 3 }));
    closeThrough(ledger, 3);
    ingest(ledger, settle("E5", "Auth-A", "185.00", { on: 4 }));

    // The last close before E7 exists: this is the "pre-E7 value" of criterion 6.
    const day4 = closeOf(closeThrough(ledger, 4)[0], ACC_AED);
    expect(decimal(day4.closingBalance)).toBe("465.00");

    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));
    const day5 = closeOf(closeThrough(ledger, 5)[0], ACC_AED);
    expect(decimal(day5.preFeeBalance)).toBe("-155.00");
    expect(decimal(day5.fee!)).toBe("25.00");
    expect(decimal(day5.closingBalance)).toBe("-180.00");

    ingest(ledger, reverse("E9", "E7", { on: 6, valued: 2 }));
    const day6 = closeOf(closeThrough(ledger, 6)[0], ACC_AED);

    // The 620.00 comes back. The 25.00 does not.
    expect(eventsOfKind(ledger, "OVERDRAFT_FEE")).toHaveLength(1);
    expect(decimal(day6.closingBalance)).toBe("440.00");
    expect(decimal(day6.closingBalance)).not.toBe(decimal(day4.closingBalance));
  });

  /**
   * Day 5 accrued nothing because no positive balance existed at that close.
   * The reversal restores the money to Day 2, but it cannot make Day 5 have
   * been solvent: that interest was foregone, not lost.
   */
  test("does not recreate interest that was never earned", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    closeThrough(ledger, 4);
    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));

    const day5 = closeOf(closeThrough(ledger, 5)[0], ACC_AED);
    expect(decimal(day5.interest)).toBe("0.00");

    ingest(ledger, reverse("E9", "E7", { on: 6, valued: 2 }));
    const day6 = closeOf(closeThrough(ledger, 6)[0], ACC_AED);

    // Day 6 accrues on its own restored balance -- 1200 - 950 - 25 = 225.00 --
    // but Day 5's zero stands. That interest was foregone, not lost.
    expect(decimal(day6.closingBalance)).toBe("225.00");
    expect(decimal(day6.interest)).toBe("0.09");
    expect(decimal(day5.interest)).toBe("0.00");
  });

  test("does not release a hold", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    ingest(ledger, debit("E7", "100.00", { on: 1 }));
    ingest(ledger, authorize("E3", "Auth-A", "200.00", { on: 1 }));

    expect(decimal(holdsOn(ledger, ACC_AED, 1))).toBe("200.00");

    ingest(ledger, reverse("E9", "E7", { on: 2, valued: 1 }));

    expect(decimal(holdsOn(ledger, ACC_AED, 2))).toBe("200.00");
  });
});

describe("reversal is refused when it has nothing sound to undo", () => {
  test("rejects a target that does not exist", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));

    const record = ingest(ledger, reverse("E9", "NOPE", { on: 2, valued: 1 }));

    expect(record.decision).toBe("REJECTED");
    expect(record.reason).toBe("NO_SUCH_EVENT");
    expect(record.postings).toHaveLength(0);
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 2))).toBe("1000.00");
  });

  test("rejects a target that was itself rejected", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    const declined = ingest(ledger, authorize("E2", "Auth-NO", "5000.00", { on: 1 }));
    expect(declined.decision).toBe("REJECTED");

    const record = ingest(ledger, reverse("E9", "E2", { on: 2, valued: 1 }));

    expect(record.decision).toBe("REJECTED");
    expect(record.reason).toBe("NO_SUCH_EVENT");
  });

  test("rejects a second reversal of the same target", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    ingest(ledger, debit("E7", "620.00", { on: 1 }));
    ingest(ledger, reverse("E9", "E7", { on: 2, valued: 1 }));

    const second = ingest(ledger, reverse("E9b", "E7", { on: 2, valued: 1 }));

    expect(second.decision).toBe("REJECTED");
    expect(second.reason).toBe("ALREADY_REVERSED");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 2))).toBe("1000.00");
  });

  /**
   * Cross-account reversal is not a business decline, it is a malformed
   * instruction: a reversal that could reach into another account's history
   * would be a hole, not a rejected request. It fails loudly.
   */
  test("refuses to reverse an event belonging to another account", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E10", "10.000", { on: 1 }, { accountId: ACC_BHD }));

    expect(() => ingest(ledger, reverse("E9", "E10", { on: 2, valued: 1 }))).toThrow(/account/i);
  });

  /**
   * A reversal that declares a value date its target does not have is a
   * contradiction in the instruction. Silently preferring one over the other
   * would hide a feed bug behind a plausible-looking posting.
   */
  test("refuses a value date that contradicts its target", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));

    expect(() => ingest(ledger, reverse("E9", "E7", { on: 6, valued: 4 }))).toThrow(/value date/i);
  });
});
