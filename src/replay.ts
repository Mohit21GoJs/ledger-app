/**
 * The supplied event stream, and the replay that drives it.
 *
 * The stream is E1…E10 in the LITERAL order the brief lists them -- which is
 * not booking order: E9 (booked Day 6) is listed before E10 (booked Day 5).
 * That is kept, not repaired. Arrival order is a fact of the feed; where an
 * event lands is decided by its own `bookedDay` and `valueDate`, never by its
 * position in the list. See AMBIGUITIES section 2.
 *
 * Replay is two passes with no interleaving: ingest every event in feed order,
 * then close Days 1…6 in order. The store forbids booking into a closed day, so
 * this ordering is the only one that lets a late-arriving, back-valued event
 * (E7 on Day 5, E9 on Day 6) be recorded before the day it belongs to is read.
 */

import { type DayClose, closeDay, ingest } from "./engine";
import { Ledger } from "./ledger";
import type { LedgerEvent, LedgerRecord } from "./ledger";
import { AED, BHD, parseAmount } from "./money";

export const ACC_AED = "ACC-001";
export const ACC_BHD = "ACC-002";

const aed = (text: string) => parseAmount(AED, text);
const bhd = (text: string) => parseAmount(BHD, text);

/** The reporting window: Days 1 through 6. */
export const WINDOW = 6;

/** E1…E10, exactly as supplied. The list is never sorted. */
export const STREAM: readonly LedgerEvent[] = [
  { kind: "CREDIT", id: "E1", accountId: ACC_AED, bookedDay: 1, valueDate: 1, amount: aed("1200.00") },
  { kind: "DEBIT", id: "E2", accountId: ACC_AED, bookedDay: 1, valueDate: 1, amount: aed("950.00") },
  {
    kind: "AUTHORIZATION",
    id: "E3",
    accountId: ACC_AED,
    bookedDay: 2,
    valueDate: 2,
    authorizationId: "Auth-A",
    amount: aed("200.00"),
  },
  { kind: "CREDIT", id: "E4", accountId: ACC_AED, bookedDay: 3, valueDate: 3, amount: aed("400.00") },
  {
    kind: "SETTLEMENT",
    id: "E5",
    accountId: ACC_AED,
    bookedDay: 4,
    valueDate: 4,
    authorizationId: "Auth-A",
    amount: aed("185.00"),
  },
  {
    kind: "SETTLEMENT",
    id: "E6",
    accountId: ACC_AED,
    bookedDay: 4,
    valueDate: 4,
    authorizationId: "Auth-Z",
    amount: aed("180.00"),
  },
  // Day-5 booking of a Day-2-valued debit: the load-bearing back-valued arrival.
  { kind: "DEBIT", id: "E7", accountId: ACC_AED, bookedDay: 5, valueDate: 2, amount: aed("620.00") },
  {
    kind: "AUTHORIZATION",
    id: "E8",
    accountId: ACC_AED,
    bookedDay: 5,
    valueDate: 5,
    authorizationId: "Auth-B",
    amount: aed("90.00"),
  },
  // Listed before E10 though booked a day later. Reverses E7 at E7's value date.
  { kind: "REVERSAL", id: "E9", accountId: ACC_AED, bookedDay: 6, valueDate: 2, reverses: "E7" },
  {
    kind: "CREDIT",
    id: "E10",
    accountId: ACC_BHD,
    bookedDay: 5,
    valueDate: 5,
    amount: bhd("10.000"),
    instalments: 3,
  },
];

export type Replay = {
  readonly ledger: Ledger;
  /** The ingest outcome of each fed event, in feed order. */
  readonly records: readonly LedgerRecord[];
  /** The close of each day, Days 1…6. */
  readonly closes: readonly DayClose[];
};

/** Both accounts from the brief, open at zero, in reporting order. */
function openAccounts(ledger: Ledger): void {
  ledger.openAccount(ACC_AED, AED);
  ledger.openAccount(ACC_BHD, BHD);
}

/** Run the brief's stream end to end and hand back everything worth reporting. */
export function replay(): Replay {
  const ledger = new Ledger();
  openAccounts(ledger);

  const records = STREAM.map((event) => ingest(ledger, event));

  const closes: DayClose[] = [];
  for (let day = 1; day <= WINDOW; day += 1) {
    closes.push(closeDay(ledger, day));
  }

  return { ledger, records, closes };
}
