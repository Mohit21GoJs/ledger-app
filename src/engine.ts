/**
 * The decision rules.
 *
 * The ledger records; the engine decides. Everything here answers one of two
 * questions: may this event be applied, and what does it post?
 *
 * Holds are not stored anywhere. An active hold is a fact about the record log
 * -- an approved authorization with no settlement against it -- so it is
 * derived on demand rather than kept in a second register that could drift out
 * of step with the log it is supposed to describe.
 */

import { add, isNegative, subtract } from "dinero.js/bigint";

import type {
  AuthorizationEvent,
  CreditEvent,
  Day,
  DebitEvent,
  Ledger,
  LedgerEvent,
  LedgerRecord,
  Posting,
  SettlementEvent,
} from "./ledger";
import { type LedgerCurrency, type Money, parseAmount, split, zero } from "./money";

export type RejectionReason = "INSUFFICIENT_AVAILABLE_BALANCE" | "NO_SUCH_AUTHORIZATION";

function negated(currency: LedgerCurrency, amount: Money): Money {
  return subtract(zero(currency), amount);
}

function postingFor(event: LedgerEvent, amount: Money): Posting {
  return {
    eventId: event.id,
    accountId: event.accountId,
    bookedDay: event.bookedDay,
    valueDate: event.valueDate,
    amount,
  };
}

/** Applied events of one kind on one account, as known by `knownOn`. */
function appliedEvents<K extends LedgerEvent["kind"]>(
  ledger: Ledger,
  kind: K,
  accountId: string,
  knownOn: Day,
): Extract<LedgerEvent, { kind: K }>[] {
  return ledger.records
    .filter(
      (record) =>
        record.decision === "APPLIED" &&
        record.event.accountId === accountId &&
        record.event.bookedDay <= knownOn,
    )
    .map((record) => record.event)
    .filter((event): event is Extract<LedgerEvent, { kind: K }> => event.kind === kind);
}

/**
 * The sum of authorizations that are approved, known by `knownOn`, and not yet
 * settled.
 *
 * A settlement releases its authorization in full, whatever it settled for --
 * see AMBIGUITIES section 5.
 */
export function holdsOn(ledger: Ledger, accountId: string, knownOn: Day): Money {
  const settled = new Set(
    appliedEvents(ledger, "SETTLEMENT", accountId, knownOn).map((event) => event.authorizationId),
  );

  return appliedEvents(ledger, "AUTHORIZATION", accountId, knownOn)
    .filter((event) => !settled.has(event.authorizationId))
    .reduce((total, event) => add(total, event.amount), zero(ledger.currencyOf(accountId)));
}

/** Ledger balance minus active holds, as at the close of `on`. */
export function availableBalance(ledger: Ledger, accountId: string, on: Day): Money {
  return subtract(ledger.balanceAsOf(accountId, on, on), holdsOn(ledger, accountId, on));
}

/** The approved, still-unsettled authorization this settlement names, if any. */
function outstandingAuthorization(
  ledger: Ledger,
  event: SettlementEvent,
): AuthorizationEvent | undefined {
  const settled = new Set(
    appliedEvents(ledger, "SETTLEMENT", event.accountId, event.bookedDay).map(
      (settlement) => settlement.authorizationId,
    ),
  );
  if (settled.has(event.authorizationId)) return undefined;

  return appliedEvents(ledger, "AUTHORIZATION", event.accountId, event.bookedDay).find(
    (authorization) => authorization.authorizationId === event.authorizationId,
  );
}

function applyCredit(ledger: Ledger, event: CreditEvent): LedgerRecord {
  // "Posted as N instalments" means N postings under one event, summing to the
  // face amount exactly -- see AMBIGUITIES section 8.
  const amounts =
    event.instalments === undefined ? [event.amount] : split(event.amount, event.instalments);

  return ledger.append({
    event,
    decision: "APPLIED",
    postings: amounts.map((amount) => postingFor(event, amount)),
  });
}

function applyDebit(ledger: Ledger, event: DebitEvent): LedgerRecord {
  // A debit may overdraw. Whether that costs a fee is settled at the day close,
  // not here: the fee is a property of a closing balance, not of one entry.
  return ledger.append({
    event,
    decision: "APPLIED",
    postings: [postingFor(event, negated(ledger.currencyOf(event.accountId), event.amount))],
  });
}

/**
 * Approve only if available balance -- ledger balance minus active holds --
 * remains at or above zero once this hold is applied. The floor is zero and it
 * is inclusive.
 *
 * An approved authorization posts NOTHING. A hold is a claim against
 * availability, not a movement of money, which is the rule acceptance
 * criterion 5 states correctly.
 */
function decideAuthorization(ledger: Ledger, event: AuthorizationEvent): LedgerRecord {
  const remaining = subtract(
    availableBalance(ledger, event.accountId, event.bookedDay),
    event.amount,
  );

  if (isNegative(remaining)) {
    return ledger.append({
      event,
      decision: "REJECTED",
      reason: "INSUFFICIENT_AVAILABLE_BALANCE" satisfies RejectionReason,
      postings: [],
    });
  }
  return ledger.append({ event, decision: "APPLIED", postings: [] });
}

/**
 * A settlement must name an authorization that exists, was approved, and has
 * not already been settled. Otherwise it is rejected with no postings: the
 * attempt stays in the record log, but no money moves.
 */
function decideSettlement(ledger: Ledger, event: SettlementEvent): LedgerRecord {
  if (!outstandingAuthorization(ledger, event)) {
    return ledger.append({
      event,
      decision: "REJECTED",
      reason: "NO_SUCH_AUTHORIZATION" satisfies RejectionReason,
      postings: [],
    });
  }

  return ledger.append({
    event,
    decision: "APPLIED",
    postings: [postingFor(event, negated(ledger.currencyOf(event.accountId), event.amount))],
  });
}

/**
 * The overdraft fee, keyed by CURRENCY CODE rather than by account.
 *
 * There is no BHD entry, deliberately. The brief names AED 25.00 and is silent
 * on BHD; converting it would need an FX rate this ledger does not have and
 * must not invent. An overdrawn BHD account therefore fails loudly instead of
 * being charged a guess. See NUMBERS.md.
 */
const OVERDRAFT_FEE: Readonly<Record<string, string>> = Object.freeze({ AED: "25.00" });

export type AccountClose = {
  readonly accountId: string;
  /** The balance the fee decision was made on. */
  readonly preFeeBalance: Money;
  /** The fee assessed, when one was. */
  readonly fee?: Money;
  /** What the day actually closed at, fee included. */
  readonly closingBalance: Money;
};

export type DayClose = {
  readonly day: Day;
  readonly accounts: readonly AccountClose[];
};

function feeFor(currency: LedgerCurrency, accountId: string, day: Day): Money {
  const scheduled = OVERDRAFT_FEE[currency.code];
  if (scheduled === undefined) {
    throw new Error(
      `NO_FEE_SCHEDULE: account ${accountId} is overdrawn on day ${day} in ` +
        `${currency.code}, and no overdraft fee is defined for that currency. ` +
        `Converting the AED fee would need an FX rate this ledger does not have.`,
    );
  }
  return parseAmount(currency, scheduled);
}

/**
 * Close one day for every account, then seal it.
 *
 * The order matters and is argued in AMBIGUITIES section 4: the fee trigger
 * reads the PRE-fee balance, so a fee can never count toward its own condition;
 * the fee is then value-dated the day assessed, so it is part of what that day
 * closed at.
 *
 * Only what was known at this close is used. A day is sealed once and never
 * re-opened, so a later back-valued arrival restates the past without ever
 * rewriting a published figure.
 */
export function closeDay(ledger: Ledger, day: Day): DayClose {
  const accounts = ledger.accountIds.map((accountId) => {
    const currency = ledger.currencyOf(accountId);
    const preFeeBalance = ledger.balanceAsOf(accountId, day, day);

    if (!isNegative(preFeeBalance)) {
      return { accountId, preFeeBalance, closingBalance: preFeeBalance };
    }

    const fee = feeFor(currency, accountId, day);
    ledger.append({
      event: {
        kind: "OVERDRAFT_FEE",
        id: `FEE-${accountId}-D${day}`,
        accountId,
        bookedDay: day,
        valueDate: day,
        amount: fee,
      },
      decision: "APPLIED",
      postings: [
        {
          eventId: `FEE-${accountId}-D${day}`,
          accountId,
          bookedDay: day,
          valueDate: day,
          amount: negated(currency, fee),
        },
      ],
    });

    return {
      accountId,
      preFeeBalance,
      fee,
      closingBalance: ledger.balanceAsOf(accountId, day, day),
    };
  });

  ledger.sealDay(day);
  return { day, accounts };
}

/** Decide one incoming event and commit the outcome. */
export function ingest(ledger: Ledger, event: LedgerEvent): LedgerRecord {
  switch (event.kind) {
    case "CREDIT":
      return applyCredit(ledger, event);
    case "DEBIT":
      return applyDebit(ledger, event);
    case "AUTHORIZATION":
      return decideAuthorization(ledger, event);
    case "SETTLEMENT":
      return decideSettlement(ledger, event);
    default:
      // OVERDRAFT_FEE and INTEREST_CAPITALIZATION are generated by the day
      // close, never received from a feed.
      throw new Error(`${event.kind} is not an event this ledger accepts from a feed`);
  }
}
