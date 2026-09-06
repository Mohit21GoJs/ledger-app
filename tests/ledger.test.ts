import { describe, expect, test } from "bun:test";

import { AED, BHD, decimal, parseAmount } from "../src/money";
import { type DebitEvent, Ledger } from "../src/ledger";

const aed = (text: string) => parseAmount(AED, text);

function ledgerWithAccount(): Ledger {
  const ledger = new Ledger();
  ledger.openAccount("ACC-001", AED);
  return ledger;
}

function debit(id: string, amount: string, bookedDay: number, valueDate: number): DebitEvent {
  return { kind: "DEBIT", id, accountId: "ACC-001", bookedDay, valueDate, amount: aed(amount) };
}

function creditOf(id: string, amount: string, bookedDay: number, valueDate: number) {
  return {
    kind: "CREDIT" as const,
    id,
    accountId: "ACC-001",
    bookedDay,
    valueDate,
    amount: aed(amount),
  };
}

/** Apply an event at its face value, posting in the given direction. */
function post(ledger: Ledger, event: DebitEvent | ReturnType<typeof creditOf>, sign: -1 | 1) {
  return ledger.append({
    event,
    decision: "APPLIED",
    postings: [
      {
        eventId: event.id,
        accountId: event.accountId,
        bookedDay: event.bookedDay,
        valueDate: event.valueDate,
        amount: sign === -1 ? parseAmount(AED, `-${decimal(event.amount)}`) : event.amount,
      },
    ],
  });
}

describe("append", () => {
  test("assigns commit sequence in arrival order", () => {
    const ledger = ledgerWithAccount();
    expect(post(ledger, creditOf("E1", "1200.00", 1, 1), 1).sequence).toBe(1);
    expect(post(ledger, debit("E2", "950.00", 1, 1), -1).sequence).toBe(2);
  });

  /**
   * The supplied stream hands over E9 (Day 6) before E10 (Day 5). Arrival order
   * and booking day are independent facts, so the store must not assume that
   * booked days arrive in ascending order -- see AMBIGUITIES section 2.
   */
  test("does not require booked days to arrive in order", () => {
    const ledger = ledgerWithAccount();
    post(ledger, creditOf("LATE", "10.00", 6, 6), 1);
    expect(() => post(ledger, creditOf("EARLY", "10.00", 5, 5), 1)).not.toThrow();
  });

  test("refuses an event for an account it does not know", () => {
    const ledger = new Ledger();
    expect(() => post(ledger, creditOf("E1", "1.00", 1, 1), 1)).toThrow(/ACC-001/);
  });

  test("refuses a reused event id", () => {
    const ledger = ledgerWithAccount();
    post(ledger, creditOf("E1", "1.00", 1, 1), 1);
    expect(() => post(ledger, creditOf("E1", "2.00", 1, 1), 1)).toThrow(/E1/);
  });

  test("refuses an event valued after the day it was booked", () => {
    const ledger = ledgerWithAccount();
    expect(() => post(ledger, creditOf("FUTURE", "1.00", 2, 5), 1)).toThrow(/value/i);
  });

  test("refuses a posting that names a different account than its event", () => {
    const ledger = ledgerWithAccount();
    ledger.openAccount("ACC-002", BHD);
    const event = creditOf("E1", "1.00", 1, 1);
    expect(() =>
      ledger.append({
        event,
        decision: "APPLIED",
        postings: [
          {
            eventId: event.id,
            accountId: "ACC-002",
            bookedDay: 1,
            valueDate: 1,
            amount: parseAmount(BHD, "1.000"),
          },
        ],
      }),
    ).toThrow(/account/i);
  });

  test("refuses a posting in a currency the account does not hold", () => {
    const ledger = ledgerWithAccount();
    const event = creditOf("E1", "1.00", 1, 1);
    expect(() =>
      ledger.append({
        event,
        decision: "APPLIED",
        postings: [
          {
            eventId: event.id,
            accountId: "ACC-001",
            bookedDay: 1,
            valueDate: 1,
            amount: parseAmount(BHD, "1.000"),
          },
        ],
      }),
    ).toThrow(/currency/i);
  });

  test("refuses postings on a rejected event", () => {
    const ledger = ledgerWithAccount();
    const event = creditOf("E1", "1.00", 1, 1);
    expect(() =>
      ledger.append({
        event,
        decision: "REJECTED",
        reason: "NO_SUCH_AUTHORIZATION",
        postings: [
          {
            eventId: event.id,
            accountId: "ACC-001",
            bookedDay: 1,
            valueDate: 1,
            amount: aed("1.00"),
          },
        ],
      }),
    ).toThrow(/rejected/i);
  });

  /**
   * A failed append must be retryable. If validation had already burned a
   * sequence number or registered the event id, the caller could never fix the
   * input and try again.
   */
  test("a failed append leaves the store untouched", () => {
    const ledger = ledgerWithAccount();
    post(ledger, creditOf("E1", "1200.00", 1, 1), 1);

    expect(() => post(ledger, creditOf("E1", "5.00", 1, 1), 1)).toThrow();

    expect(ledger.records).toHaveLength(1);
    expect(post(ledger, creditOf("E2", "5.00", 1, 1), 1).sequence).toBe(2);
  });
});

describe("immutability", () => {
  test("history does not change when the caller mutates what it passed", () => {
    const ledger = ledgerWithAccount();
    const event = { ...creditOf("E1", "1200.00", 1, 1) };
    post(ledger, event, 1);

    // The caller still holds a reference to its own object and edits it.
    (event as { id: string }).id = "TAMPERED";
    (event as { bookedDay: number }).bookedDay = 99;

    const [record] = ledger.records;
    expect(record?.event.id).toBe("E1");
    expect(record?.event.bookedDay).toBe(1);
  });

  test("committed records are frozen", () => {
    const ledger = ledgerWithAccount();
    const record = post(ledger, creditOf("E1", "1200.00", 1, 1), 1);
    expect(Object.isFrozen(record)).toBe(true);
    expect(Object.isFrozen(record.event)).toBe(true);
    expect(Object.isFrozen(record.postings)).toBe(true);
  });
});

describe("balanceAsOf", () => {
  /**
   * The load-bearing test of the whole store. E7 is a Day-5 booking of a
   * Day-2-valued debit, so "the Day 2 balance" has two correct answers and the
   * caller must always say which one it means -- see AMBIGUITIES section 1.
   */
  test("separates what a day closed at from what we now believe it was", () => {
    const ledger = ledgerWithAccount();
    post(ledger, creditOf("E1", "1200.00", 1, 1), 1);
    post(ledger, debit("E2", "950.00", 1, 1), -1);
    post(ledger, debit("E7", "620.00", 5, 2), -1);

    // What Day 2 closed at, on Day 2: E7 was not yet known.
    expect(decimal(ledger.balanceAsOf("ACC-001", 2, 2))).toBe("250.00");

    // What we believe Day 2 was, knowing everything through Day 5.
    expect(decimal(ledger.balanceAsOf("ACC-001", 2, 5))).toBe("-370.00");
  });

  test("an account with no postings is at zero in its own currency", () => {
    const ledger = ledgerWithAccount();
    ledger.openAccount("ACC-002", BHD);
    expect(decimal(ledger.balanceAsOf("ACC-001", 6, 6))).toBe("0.00");
    expect(decimal(ledger.balanceAsOf("ACC-002", 6, 6))).toBe("0.000");
  });

  test("a rejected event moves no money", () => {
    const ledger = ledgerWithAccount();
    post(ledger, creditOf("E1", "1200.00", 1, 1), 1);
    ledger.append({
      event: debit("E6", "180.00", 4, 4),
      decision: "REJECTED",
      reason: "NO_SUCH_AUTHORIZATION",
      postings: [],
    });
    expect(decimal(ledger.balanceAsOf("ACC-001", 6, 6))).toBe("1200.00");
  });

  test("excludes entries valued after the cutoff", () => {
    const ledger = ledgerWithAccount();
    post(ledger, creditOf("E1", "1200.00", 1, 1), 1);
    post(ledger, creditOf("E4", "400.00", 3, 3), 1);
    expect(decimal(ledger.balanceAsOf("ACC-001", 2, 6))).toBe("1200.00");
    expect(decimal(ledger.balanceAsOf("ACC-001", 3, 6))).toBe("1600.00");
  });
});

describe("day lifecycle", () => {
  /**
   * Without this, "one overdraft fee per account per day" is unenforceable: a
   * late arrival could change a day whose fee decision has already been
   * published -- see AMBIGUITIES section 10.
   */
  test("a closed day accepts no further events", () => {
    const ledger = ledgerWithAccount();
    ledger.sealDay(1);
    expect(() => post(ledger, creditOf("LATE", "1.00", 1, 1), 1)).toThrow(/closed/i);
  });

  test("a later booked day is still open after an earlier one closes", () => {
    const ledger = ledgerWithAccount();
    ledger.sealDay(1);
    expect(() => post(ledger, creditOf("E4", "400.00", 3, 3), 1)).not.toThrow();
  });

  test("days seal once, and in order", () => {
    const ledger = ledgerWithAccount();
    ledger.sealDay(1);
    expect(() => ledger.sealDay(1)).toThrow(/order|closed/i);
    expect(() => ledger.sealDay(3)).toThrow(/order/i);
    expect(() => ledger.sealDay(2)).not.toThrow();
  });
});
