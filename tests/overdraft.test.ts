import { describe, expect, test } from "bun:test";

import { closeDay, ingest } from "../src/engine";
import { decimal } from "../src/money";
import { ACC_AED, ACC_BHD, credit, debit, newLedger } from "./support";

/** Close days up to and including `through`, resuming from wherever the ledger is. */
function closeThrough(ledger: ReturnType<typeof newLedger>, through: number) {
  const closes = [];
  for (let day = ledger.closedThrough + 1; day <= through; day += 1) {
    closes.push(closeDay(ledger, day));
  }
  return closes;
}

const feesIn = (ledger: ReturnType<typeof newLedger>) =>
  ledger.records.filter((record) => record.event.kind === "OVERDRAFT_FEE");

describe("overdraft fee", () => {
  test("is not assessed on a positive closing balance", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    closeThrough(ledger, 1);

    expect(feesIn(ledger)).toHaveLength(0);
  });

  /** "Negative" means below zero. A balance of exactly zero is not overdrawn. */
  test("is not assessed on a closing balance of exactly zero", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "100.00", { on: 1 }));
    ingest(ledger, debit("E2", "100.00", { on: 1 }));
    closeThrough(ledger, 1);

    expect(decimal(ledger.balanceAsOf(ACC_AED, 1, 1))).toBe("0.00");
    expect(feesIn(ledger)).toHaveLength(0);
  });

  test("is AED 25.00, booked with value_date equal to the day assessed", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "100.00", { on: 1 }));
    closeThrough(ledger, 1);

    const [fee] = feesIn(ledger);
    expect(fee?.event.valueDate).toBe(1);
    expect(fee?.event.bookedDay).toBe(1);
    expect(fee?.postings.map((p) => decimal(p.amount))).toEqual(["-25.00"]);
    expect(decimal(ledger.balanceAsOf(ACC_AED, 1, 1))).toBe("-125.00");
  });

  /**
   * Once per day per account, not once per entry that pushed it under. Three
   * overdrawing debits on one day are still one fee.
   */
  test("is assessed at most once per account per day", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "10.00", { on: 1 }));
    ingest(ledger, debit("E2", "10.00", { on: 1 }));
    ingest(ledger, debit("E3", "10.00", { on: 1 }));
    closeThrough(ledger, 1);

    expect(feesIn(ledger)).toHaveLength(1);
  });

  /**
   * The trigger reads the PRE-fee balance, so the fee cannot count toward its
   * own condition. Otherwise the test would be circular -- see AMBIGUITIES
   * section 4.
   */
  test("reads the pre-fee balance and does not cascade", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "10.00", { on: 1 }));

    const [close] = closeThrough(ledger, 1);
    const account = close?.accounts.find((a) => a.accountId === ACC_AED);

    expect(decimal(account?.preFeeBalance!)).toBe("-10.00");
    expect(decimal(account?.fee!)).toBe("25.00");
    expect(decimal(account?.closingBalance!)).toBe("-35.00");
    expect(feesIn(ledger)).toHaveLength(1);
  });

  test("charges each overdrawn day separately", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "10.00", { on: 1 }));
    ingest(ledger, debit("E2", "10.00", { on: 2 }));
    closeThrough(ledger, 2);

    expect(feesIn(ledger).map((fee) => fee.event.valueDate)).toEqual([1, 2]);
  });

  /**
   * The brief names AED 25.00 and is silent on BHD. Converting it would need an
   * FX rate this ledger does not have and must not invent, so the schedule has
   * no BHD entry and an overdrawn BHD account fails loudly.
   */
  test("refuses to guess a fee for a currency with no schedule", () => {
    const ledger = newLedger();
    ingest(ledger, debit("E1", "5.000", { on: 1 }, { accountId: ACC_BHD }));

    expect(() => closeDay(ledger, 1)).toThrow(/NO_FEE_SCHEDULE/);
  });

  test("leaves a solvent BHD account alone, schedule or not", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E10", "10.000", { on: 1 }, { accountId: ACC_BHD, instalments: 3 }));

    expect(() => closeThrough(ledger, 1)).not.toThrow();
    expect(decimal(ledger.balanceAsOf(ACC_BHD, 1, 1))).toBe("10.000");
  });
});

describe("knowledge-dated assessment", () => {
  /**
   * The headline decision, and the one acceptance criterion 2 gets wrong.
   *
   * E7 is a Day-5 booking of a Day-2-valued debit. Day 2 closed at +250.00 on
   * Day 2 and was sealed; the fee E7 causes is assessed at the Day-5 close and
   * value-dated Day 5 -- see AMBIGUITIES section 3.
   */
  test("assesses E7's fee on Day 5, the day it became known", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    closeThrough(ledger, 4);

    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));
    closeThrough(ledger, 5);

    const fees = feesIn(ledger);
    expect(fees).toHaveLength(1);
    expect(fees[0]?.event.valueDate).toBe(5);
    expect(fees[0]?.event.bookedDay).toBe(5);
  });

  test("does not restate a day that already closed", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    closeThrough(ledger, 4);
    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));
    closeThrough(ledger, 5);

    // Day 2 still closed at what it closed at, on the day it closed.
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 2))).toBe("250.00");
    // And the restated view of Day 2 is visible without having been published.
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 5))).toBe("-370.00");
  });
});

describe("day close lifecycle", () => {
  test("seals the day against further events", () => {
    const ledger = newLedger();
    closeDay(ledger, 1);

    expect(() => ingest(ledger, credit("LATE", "1.00", { on: 1 }))).toThrow(/closed/i);
  });

  test("closes days once and in order", () => {
    const ledger = newLedger();
    closeDay(ledger, 1);

    expect(() => closeDay(ledger, 1)).toThrow(/order/i);
    expect(() => closeDay(ledger, 3)).toThrow(/order/i);
    expect(() => closeDay(ledger, 2)).not.toThrow();
  });

  test("reports every account, overdrawn or not", () => {
    const ledger = newLedger();
    const close = closeDay(ledger, 1);

    expect(close.accounts.map((a) => a.accountId)).toEqual([ACC_AED, ACC_BHD]);
    expect(close.accounts.every((a) => a.fee === undefined)).toBe(true);
  });
});
