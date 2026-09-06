/**
 * The event vocabulary, and the append-only bitemporal store that holds it.
 *
 * Every event carries two independent clocks:
 *
 *   bookedDay  knowledge time -- the day the bank learned the fact.
 *   valueDate  effective time -- the day the money is deemed to have moved.
 *              May be earlier than bookedDay (E7, E9); never later.
 *
 * So there is no such thing as "the balance". There is only
 * `balanceAsOf(account, valueDate, knownOn)`, with both cutoffs named every
 * time. See AMBIGUITIES section 1 for why that is the whole design.
 *
 * This module decides nothing. It records what it is given, refuses what would
 * corrupt the history, and answers questions about postings. Every business
 * rule -- who is approved, what a settlement releases, when a fee is due --
 * lives in the engine.
 */

import { add, isNegative, isZero, toSnapshot } from "dinero.js/bigint";

import { type LedgerCurrency, type Money, decimal, zero } from "./money";

export type Day = number;

type EventBase = {
  /** Stable identity. An id names one event forever and is never reused. */
  readonly id: string;
  readonly accountId: string;
  readonly bookedDay: Day;
  readonly valueDate: Day;
  /** Position in the incoming feed, when the event came from one. */
  readonly streamIndex?: number;
};

export type CreditEvent = EventBase & {
  readonly kind: "CREDIT";
  readonly amount: Money;
  /** When present, the credit posts as this many instalments summing to `amount`. */
  readonly instalments?: number;
};

export type DebitEvent = EventBase & {
  readonly kind: "DEBIT";
  readonly amount: Money;
};

export type AuthorizationEvent = EventBase & {
  readonly kind: "AUTHORIZATION";
  readonly authorizationId: string;
  readonly amount: Money;
};

export type SettlementEvent = EventBase & {
  readonly kind: "SETTLEMENT";
  readonly authorizationId: string;
  readonly amount: Money;
};

export type ReversalEvent = EventBase & {
  readonly kind: "REVERSAL";
  readonly reverses: string;
};

export type OverdraftFeeEvent = EventBase & {
  readonly kind: "OVERDRAFT_FEE";
  readonly amount: Money;
};

export type Accrual = { readonly day: Day; readonly amount: Money };

export type CapitalizationEvent = EventBase & {
  readonly kind: "INTEREST_CAPITALIZATION";
  readonly amount: Money;
  /** The stored daily accruals this credit is the sum of. */
  readonly accruals: readonly Accrual[];
};

export type LedgerEvent =
  | CreditEvent
  | DebitEvent
  | AuthorizationEvent
  | SettlementEvent
  | ReversalEvent
  | OverdraftFeeEvent
  | CapitalizationEvent;

/**
 * A signed movement of money. Postings are the only things balances are made
 * of: an event that produces none moved no money, whatever else it recorded.
 */
export type Posting = {
  readonly eventId: string;
  readonly accountId: string;
  readonly bookedDay: Day;
  readonly valueDate: Day;
  readonly amount: Money;
};

export type Decision = "APPLIED" | "REJECTED";

export type LedgerRecord = {
  /** Commit order, 1-based. Not the same thing as booked day. */
  readonly sequence: number;
  readonly event: LedgerEvent;
  readonly decision: Decision;
  /** Why, when the decision is REJECTED. */
  readonly reason?: string;
  readonly postings: readonly Posting[];
};

export type AppendRequest = {
  readonly event: LedgerEvent;
  readonly decision: Decision;
  readonly reason?: string;
  readonly postings: readonly Posting[];
};

/**
 * Snapshot an event on the way in.
 *
 * A shallow copy is enough, and is deliberately all we do. The only nested
 * values an event holds are dinero amounts, which are immutable by
 * construction; recursing into a library's own objects to freeze their
 * internals is how you break it. What this protects against is the caller
 * keeping a reference to the object it passed and editing it afterwards.
 */
function snapshotOf(event: LedgerEvent): LedgerEvent {
  const copy = { ...event };
  if ("accruals" in copy) {
    (copy as { accruals: readonly Accrual[] }).accruals = Object.freeze(
      copy.accruals.map((accrual) => Object.freeze({ ...accrual })),
    );
  }
  return Object.freeze(copy);
}

export class Ledger {
  readonly #accounts = new Map<string, LedgerCurrency>();
  readonly #records: LedgerRecord[] = [];
  readonly #postings: Posting[] = [];
  readonly #eventIds = new Set<string>();
  #closedThrough: Day = 0;

  /** Accounts open at zero. A zero-valued opening event would record nothing. */
  openAccount(accountId: string, currency: LedgerCurrency): void {
    if (this.#accounts.has(accountId)) {
      throw new Error(`account ${accountId} is already open`);
    }
    this.#accounts.set(accountId, currency);
  }

  get records(): readonly LedgerRecord[] {
    return this.#records;
  }

  /** Open accounts, in the order they were opened. */
  get accountIds(): readonly string[] {
    return [...this.#accounts.keys()];
  }

  get closedThrough(): Day {
    return this.#closedThrough;
  }

  currencyOf(accountId: string): LedgerCurrency {
    const currency = this.#accounts.get(accountId);
    if (!currency) throw new Error(`no such account: ${accountId}`);
    return currency;
  }

  /**
   * Commit one attempted event.
   *
   * Everything is validated BEFORE anything is committed, so a rejected append
   * leaves the store byte-identical to before it. That is what makes a failed
   * append retryable: it cannot burn a sequence number or an event id on the
   * way out.
   */
  append(request: AppendRequest): LedgerRecord {
    const { event, decision, reason, postings } = request;

    this.#validate(event, decision, postings);

    const record: LedgerRecord = Object.freeze({
      sequence: this.#records.length + 1,
      event: snapshotOf(event),
      decision,
      ...(reason === undefined ? {} : { reason }),
      postings: Object.freeze(postings.map((posting) => Object.freeze({ ...posting }))),
    });

    this.#eventIds.add(event.id);
    this.#records.push(record);
    this.#postings.push(...record.postings);
    return record;
  }

  #validate(event: LedgerEvent, decision: Decision, postings: readonly Posting[]): void {
    const currency = this.currencyOf(event.accountId);

    if (this.#eventIds.has(event.id)) {
      throw new Error(`event id ${event.id} has already been recorded`);
    }
    if (!Number.isInteger(event.bookedDay) || event.bookedDay < 1) {
      throw new Error(`event ${event.id} has an invalid booked day ${event.bookedDay}`);
    }
    if (!Number.isInteger(event.valueDate) || event.valueDate < 1) {
      throw new Error(`event ${event.id} has an invalid value date ${event.valueDate}`);
    }
    if (event.valueDate > event.bookedDay) {
      throw new Error(
        `event ${event.id} is valued on day ${event.valueDate} but was only booked on ` +
          `day ${event.bookedDay}: the ledger does not accept forward-valued entries`,
      );
    }
    if (event.bookedDay <= this.#closedThrough) {
      throw new Error(
        `day ${event.bookedDay} is closed; event ${event.id} cannot be booked into it`,
      );
    }
    if ("amount" in event && (isNegative(event.amount) || isZero(event.amount))) {
      throw new Error(
        `event ${event.id} carries a face amount of ${decimal(event.amount)}: ` +
          `face amounts are positive and direction comes from the event kind`,
      );
    }
    if (decision === "REJECTED" && postings.length > 0) {
      throw new Error(`event ${event.id} was rejected, so it cannot post ${postings.length} entries`);
    }

    for (const posting of postings) {
      if (posting.accountId !== event.accountId) {
        throw new Error(
          `posting for event ${event.id} names account ${posting.accountId}, ` +
            `but the event names ${event.accountId}`,
        );
      }
      const postingCurrency = toSnapshot(posting.amount).currency;
      if (postingCurrency.code !== currency.code || postingCurrency.exponent !== currency.exponent) {
        throw new Error(
          `currency mismatch: posting for event ${event.id} is in ` +
            `${postingCurrency.code}/${postingCurrency.exponent}dp, but account ` +
            `${event.accountId} holds ${currency.code}/${currency.exponent}dp, ` +
            `and this ledger has no FX rate to reconcile them`,
        );
      }
    }
  }

  /**
   * The balance of an account, over entries effective by `valueDate`, using
   * only what was known by `knownOn`.
   *
   * Both cutoffs are required. `balanceAsOf(a, 2, 2)` is what Day 2 closed at
   * on Day 2; `balanceAsOf(a, 2, 5)` is what we believe Day 2 was, knowing
   * everything through Day 5. Defaulting either one is how those two get
   * confused, so neither has a default.
   */
  balanceAsOf(accountId: string, valueDate: Day, knownOn: Day): Money {
    const currency = this.currencyOf(accountId);
    return this.#postings
      .filter(
        (posting) =>
          posting.accountId === accountId &&
          posting.valueDate <= valueDate &&
          posting.bookedDay <= knownOn,
      )
      .reduce((total, posting) => add(total, posting.amount), zero(currency));
  }

  /** Records booked on a given day, in commit order. */
  recordsBookedOn(day: Day): readonly LedgerRecord[] {
    return this.#records.filter((record) => record.event.bookedDay === day);
  }

  /**
   * Seal a day against further events. Days seal once and in ascending order,
   * so a fee decision published at a close can never be contradicted by a later
   * arrival. The engine's `closeDay` runs the business close and calls this
   * last.
   */
  sealDay(day: Day): void {
    if (day !== this.#closedThrough + 1) {
      throw new Error(
        `days close in order: expected day ${this.#closedThrough + 1}, got day ${day}`,
      );
    }
    this.#closedThrough = day;
  }
}
