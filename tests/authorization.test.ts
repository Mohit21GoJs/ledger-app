import { describe, expect, test } from "bun:test";

import { availableBalance, holdsOn, ingest } from "../src/engine";
import { decimal } from "../src/money";
import { ACC_AED, authorize, credit, debit, newLedger, settle } from "./support";

describe("authorization", () => {
  /**
   * "Approved only if the account's available balance -- ledger balance minus
   * active holds -- remains at or above zero after the hold is applied."
   * The floor is zero and it is inclusive.
   */
  test("approves while available balance stays at or above zero", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));

    const record = ingest(ledger, authorize("E3", "Auth-A", "200.00", { on: 2 }));

    expect(record.decision).toBe("APPLIED");
    expect(decimal(availableBalance(ledger, ACC_AED, 2))).toBe("50.00");
  });

  test("approves a hold that lands exactly on zero", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "100.00", { on: 1 }));

    const record = ingest(ledger, authorize("E2", "Auth-EXACT", "100.00", { on: 1 }));

    expect(record.decision).toBe("APPLIED");
    expect(decimal(availableBalance(ledger, ACC_AED, 1))).toBe("0.00");
  });

  test("declines a hold that would take available balance below zero", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "100.00", { on: 1 }));

    const record = ingest(ledger, authorize("E2", "Auth-TOO-BIG", "100.01", { on: 1 }));

    expect(record.decision).toBe("REJECTED");
    expect(record.reason).toBe("INSUFFICIENT_AVAILABLE_BALANCE");
  });

  /**
   * Acceptance criterion 5 states this rule, and the rule is right: a hold is a
   * claim against availability, never a posting.
   */
  test("an approved hold reduces available balance but not ledger balance", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, authorize("E2", "Auth-A", "200.00", { on: 1 }));

    expect(decimal(ledger.balanceAsOf(ACC_AED, 1, 1))).toBe("1200.00");
    expect(decimal(availableBalance(ledger, ACC_AED, 1))).toBe("1000.00");
  });

  test("a declined authorization creates no hold", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "100.00", { on: 1 }));
    ingest(ledger, authorize("E2", "Auth-TOO-BIG", "500.00", { on: 1 }));

    expect(decimal(holdsOn(ledger, ACC_AED, 1))).toBe("0.00");
    expect(decimal(availableBalance(ledger, ACC_AED, 1))).toBe("100.00");
  });

  test("holds accumulate while they are outstanding", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    ingest(ledger, authorize("E2", "Auth-1", "200.00", { on: 1 }));
    ingest(ledger, authorize("E3", "Auth-2", "300.00", { on: 1 }));

    expect(decimal(holdsOn(ledger, ACC_AED, 1))).toBe("500.00");
    expect(decimal(availableBalance(ledger, ACC_AED, 1))).toBe("500.00");
  });

  test("a hold is invisible before the day it was placed", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1000.00", { on: 1 }));
    ingest(ledger, authorize("E2", "Auth-1", "200.00", { on: 3 }));

    expect(decimal(holdsOn(ledger, ACC_AED, 2))).toBe("0.00");
    expect(decimal(holdsOn(ledger, ACC_AED, 3))).toBe("200.00");
  });

  /**
   * The Auth-B case from the brief. Available is already negative before its
   * hold, so the conditional in acceptance criterion 5 never fires -- see
   * AMBIGUITIES section 7.
   */
  test("declines Auth-B on the real Day-5 position", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    ingest(ledger, authorize("E3", "Auth-A", "200.00", { on: 2 }));
    ingest(ledger, credit("E4", "400.00", { on: 3 }));
    ingest(ledger, settle("E5", "Auth-A", "185.00", { on: 4 }));
    ingest(ledger, debit("E7", "620.00", { on: 5, valued: 2 }));

    // Auth-A settled on Day 4, so its hold is released and nothing else is
    // outstanding: available is the ledger balance, and it is already negative.
    expect(decimal(holdsOn(ledger, ACC_AED, 5))).toBe("0.00");
    expect(decimal(availableBalance(ledger, ACC_AED, 5))).toBe("-155.00");

    const record = ingest(ledger, authorize("E8", "Auth-B", "90.00", { on: 5 }));
    expect(record.decision).toBe("REJECTED");
    expect(record.reason).toBe("INSUFFICIENT_AVAILABLE_BALANCE");
  });
});

describe("settlement", () => {
  function withApprovedAuthA() {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));
    ingest(ledger, authorize("E3", "Auth-A", "200.00", { on: 2 }));
    return ledger;
  }

  test("posts the settled amount against the ledger balance", () => {
    const ledger = withApprovedAuthA();

    const record = ingest(ledger, settle("E5", "Auth-A", "185.00", { on: 4 }));

    expect(record.decision).toBe("APPLIED");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 4, 4))).toBe("65.00");
  });

  /**
   * Auth-A holds 200.00 and settles for 185.00. An authorization is a
   * reservation, not a debt: once the transaction it reserved for has settled,
   * the reservation has served its purpose. Retaining a 15.00 residual would
   * strand the customer's own funds behind an authorization that no event in
   * this stream would ever release -- see AMBIGUITIES section 5.
   */
  test("releases the whole hold even when it settles for less", () => {
    const ledger = withApprovedAuthA();
    expect(decimal(holdsOn(ledger, ACC_AED, 3))).toBe("200.00");

    ingest(ledger, settle("E5", "Auth-A", "185.00", { on: 4 }));

    expect(decimal(holdsOn(ledger, ACC_AED, 4))).toBe("0.00");
    expect(decimal(availableBalance(ledger, ACC_AED, 4))).toBe("65.00");
  });

  /**
   * Acceptance criterion 4, which is correct and is implemented as stated.
   * "The funds must not leave the account" is satisfied by posting nothing --
   * the attempt is still recorded, so it stays auditable.
   */
  test("rejects a settlement for an authorization that never existed", () => {
    const ledger = withApprovedAuthA();
    const before = decimal(ledger.balanceAsOf(ACC_AED, 6, 6));

    const record = ingest(ledger, settle("E6", "Auth-Z", "180.00", { on: 4 }));

    expect(record.decision).toBe("REJECTED");
    expect(record.reason).toBe("NO_SUCH_AUTHORIZATION");
    expect(record.postings).toHaveLength(0);
    expect(decimal(ledger.balanceAsOf(ACC_AED, 6, 6))).toBe(before);
  });

  test("records the rejected attempt rather than dropping it", () => {
    const ledger = withApprovedAuthA();
    ingest(ledger, settle("E6", "Auth-Z", "180.00", { on: 4 }));

    expect(ledger.records.at(-1)?.event.id).toBe("E6");
  });

  test("will not settle the same authorization twice", () => {
    const ledger = withApprovedAuthA();
    ingest(ledger, settle("E5", "Auth-A", "185.00", { on: 4 }));

    const second = ingest(ledger, settle("E5b", "Auth-A", "10.00", { on: 4 }));

    expect(second.decision).toBe("REJECTED");
    expect(second.reason).toBe("NO_SUCH_AUTHORIZATION");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 4, 4))).toBe("65.00");
  });

  test("will not settle an authorization that was declined", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "100.00", { on: 1 }));
    ingest(ledger, authorize("E2", "Auth-NO", "500.00", { on: 1 }));

    const record = ingest(ledger, settle("E3", "Auth-NO", "500.00", { on: 2 }));

    expect(record.decision).toBe("REJECTED");
    expect(record.reason).toBe("NO_SUCH_AUTHORIZATION");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 2, 2))).toBe("100.00");
  });
});

describe("credit and debit", () => {
  test("a credit posts its face amount, a debit posts the negative of it", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "1200.00", { on: 1 }));
    ingest(ledger, debit("E2", "950.00", { on: 1 }));

    expect(decimal(ledger.balanceAsOf(ACC_AED, 1, 1))).toBe("250.00");
  });

  /**
   * E10. Three EQUAL instalments of BHD 10.000 do not exist; three that sum to
   * exactly 10.000 do -- see AMBIGUITIES section 8.
   */
  test("an instalment credit posts one entry per instalment, conserving the total", () => {
    const ledger = newLedger();
    const record = ingest(
      ledger,
      credit("E10", "10.000", { on: 5 }, { accountId: "ACC-002", instalments: 3 }),
    );

    expect(record.postings.map((p) => decimal(p.amount))).toEqual(["3.334", "3.333", "3.333"]);
    expect(decimal(ledger.balanceAsOf("ACC-002", 5, 5))).toBe("10.000");
  });

  test("a debit is allowed to overdraw -- the fee is a day-close matter", () => {
    const ledger = newLedger();
    ingest(ledger, credit("E1", "100.00", { on: 1 }));

    const record = ingest(ledger, debit("E2", "620.00", { on: 1 }));

    expect(record.decision).toBe("APPLIED");
    expect(decimal(ledger.balanceAsOf(ACC_AED, 1, 1))).toBe("-520.00");
  });
});
