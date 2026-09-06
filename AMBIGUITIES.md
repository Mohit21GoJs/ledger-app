# Ambiguities


Only ambiguities that change a number or a decision in this replay are listed. For each: what is unclear, what the options are, what I chose, and what the choice costs. Where a resolution is contestable I say so rather than presenting it as forced.

---

## 1. "Closing ledger balance" names two different quantities

The brief says the overdraft fee is assessed when "that day's closing ledger balance (all entries with `value_date ≤ that day`) is negative". That parenthetical defines a filter on *value date* and says nothing about *when the entry became known*.

Every event here carries two independent clocks:

- **`bookedDay`** — knowledge time. The day the bank learned the fact. Monotonic; the past is fixed.
- **`valueDate`** — effective time. The day the money is deemed to have moved. May be earlier than `bookedDay` (E7, E9). Never later, in this stream.

So "the Day 2 balance" is under-specified. It has at least two correct answers:

| Question | Filter | Answer |
|---|---|---|
| What did Day 2 close at, on Day 2? | `valueDate ≤ 2` and `bookedDay ≤ 2` | +250.00 |
| What do we now believe Day 2 was, knowing everything through Day 5? | `valueDate ≤ 2` and `bookedDay ≤ 5` | −370.00 |

**Resolution.** The single balance primitive is `balanceAsOf(account, valueDate, knownOn)` — both cutoffs always explicit, never defaulted. An *operational close* of day D is `balanceAsOf(acct, D, D)`. A *restated* balance names its knowledge date separately. Nothing in the codebase is allowed to say "the balance" without answering both questions.

**Cost.** Every caller must decide which one it means. That is the point: the acceptance criteria contain at least one place where the two were conflated, and a single-clock design would have hidden it.

---

## 2. The stream is not in booking order

The brief says "replayed in this order" and then lists E9 (Day 6) before E10 (Day 5). Either the ordering is a typo, or arrival order is genuinely independent of booking day.

**Resolution.** Take the instruction literally. Events are ingested E1…E10 in exactly the order given, and each retains its position in the feed. The ledger never sorts the source stream. Day-level reporting groups by `bookedDay`, which is a *view* over the committed records, not a reordering of them.

**Why not sort.** Re-sorting the stream into booking order would make replay a function of my interpretation rather than of the input. It would also quietly discard the fact that the feed handed them over out of order — a fact a real reconciliation would need to keep. E10 still lands on Day 5 because its `bookedDay` and `valueDate` both say 5; arriving late in the feed does not move it.

---

## 3. When is E7's overdraft fee assessed?

This is the load-bearing ambiguity of the whole exercise, and the one I expect to defend hardest.

E7 is a Day-5 booking of a Day-2-valued debit. Its arrival makes the *restated* Day-2 balance −370.00. Two readings follow:

**(a) Value-time.** The fee belongs to the day whose value-dated balance went negative, i.e. Day 2. Re-open Day 2 and book a fee there.

**(b) Knowledge-time.** Day D's fee is decided once, at D's close, from what was known at D's close. A closed day is never re-opened. E7 becomes known on Day 5, so the fee is assessed at the Day-5 close and value-dated Day 5.

**Resolution: (b).**

Three reasons, in order of weight:

1. The brief's own words: a fee is "booked with `value_date` equal to the day assessed." Under (a) the day assessed is still today — Day 5 — so a Day-2-dated fee would violate the non-negotiable rule it is trying to satisfy.
2. A fee is a customer-facing notification. Dating it before the bank knew the fact that caused it asserts the bank charged for something it had not yet learned.
3. Reading (a) does not survive its own arithmetic on this stream. Applying it consistently, the restated balance is negative on Day 2 (−370.00), Day 4 (−155.00) and Day 5 (−155.00), so it yields *three* fees, not one. Whatever else is true, "exactly one fee, on Day 2" is not a consequence of (a) either.

**Cost, stated plainly.** Under (b) the fee history is a function of `(ledger content, arrival order)` rather than of ledger content alone. Two ledgers holding identical value-dated entries can carry different fees if the entries arrived on different days. That is a real loss of a property most people assume a ledger has, and I am not going to pretend otherwise — it is what the required deliberate failing test demonstrates.

I considered and rejected every repair: back-dating the fee breaks the value-date rule; issuing catch-up fees dated today charges three AED 25.00 in a single day for one back-valued debit; recomputing the window from scratch on each arrival breaks append-only; deferring all assessment to the end of the window is no longer a daily fee. Each fix costs more than the property is worth.

---

## 4. What happens in what order at a day close

The brief fixes the ingredients but not the sequence, and the sequence changes numbers.

Two sub-questions:

- **Does the fee count toward its own trigger?** If it did, the test would be circular. Resolution: the trigger is evaluated on the **pre-fee** close.
- **Does the fee reduce the interest base?** The fee is value-dated the day it is assessed, so it is part of that day's closing balance by definition. Resolution: interest accrues on the **post-fee** close.

So each account's close is: compute pre-fee close → assess at most one fee → compute post-fee close → accrue interest on it.

On this stream the distinction is invisible — Day 5 is negative before and after the fee, so it earns nothing either way. It is written down because it is invisible: an untested ordering choice is where a second reader's numbers start diverging from mine.

**Related: does interest compound inside the window?** No. Accruals capitalize as a single credit at end of Day 6, so they are not part of the ledger balance on Days 1–5 and cannot form part of a later day's base. Six simple accruals, no compounding.

---

## 5. A settlement for less than its hold

Auth-A holds AED 200.00 and settles for AED 185.00. The brief does not say what becomes of the 15.00 difference.

**Resolution.** The settlement posts −185.00 and releases the hold **in full**. An authorization is a reservation, not a debt; once the transaction it was reserving for has settled, the reservation has served its purpose.

**Rejected alternative.** Retaining a 15.00 residual hold would strand the customer's own funds behind an authorization that no longer has anything to settle, with no event in the stream that would ever release it. Partial-capture and multi-capture flows do exist in card networks, but nothing here signals one, and inventing the lifecycle to manage it would be inventing requirements.

---

## 6. A settlement against an authorization that never existed

E6 settles Auth-Z, which has no preceding authorization event. "Rejected" is clear enough; what is unclear is whether a rejected event is *recorded*.

**Resolution.** Yes. Every ingested event produces exactly one immutable record, carrying its decision. A rejected event produces a record with **zero postings** — so it is fully visible in the audit trail and contributes nothing to any balance. "The funds must not leave the account" is satisfied by having no posting, not by having no record.

**Note.** This is the conservative reading and it matches the criterion. In a live card system an unmatched settlement usually cannot simply be dropped — it becomes a force-post or lands in a suspense account, because the money has already moved at the network. That machinery is out of scope here, but the difference is real and I would raise it before shipping this against a real scheme.

---

## 7. Auth-B: a correct rule stated about a case that does not occur

One criterion says "*If* Auth-B is approved, its hold reduces available balance but not ledger balance." The rule is right, and it is the rule I implement: a hold is a claim against availability, never a posting.

But Auth-B is **not** approved. At the Day-5 close, before its hold, ACC-001's available balance is already −155.00 (Auth-A's hold was released at settlement on Day 4, so nothing else is outstanding). Applying a 90.00 hold would take availability to −245.00, and the approval rule requires it to remain at or above zero.

**Resolution.** Implement the rule; decline Auth-B. The criterion is a true conditional with a false antecedent, so it is not wrong — but it is not evidence about this stream either, and reading it as "Auth-B is approved" would be a mistake. The brief's later remark that "Auth-B is never settled inside the window" reads as though approval were assumed; nothing in the rules makes it so.

---

## 8. Three equal instalments that cannot be equal

E10 credits BHD 10.000 "posted as three equal instalments". BHD stores 3 decimals. 10.000 / 3 = 3.333… which is not storable, and no three equal storable BHD amounts sum to 10.000.

The requirement is unsatisfiable as literally written. Something must give:

| Give up | Result |
|---|---|
| Equality | 3.334 + 3.333 + 3.333 = 10.000 |
| Conservation | 3.334 × 3 = 10.002 — the bank invents 0.002 |
| Precision | 3.333… — not a BHD amount |

**Resolution.** Conservation wins, unambiguously. A ledger that does not conserve is not a ledger. The split is largest-remainder with the extra minor unit handed out from the front, so an early instalment is never below its fair share and a partially-applied split can never under-credit the customer. "Equal" is downgraded to "as equal as BHD permits".

---

## 9. What a reversal does and does not undo

E9 "reverses E7". The scope of that verb is entirely unspecified.

**Resolution.** A reversal is an ordinary append: it books postings equal and opposite to its target's, at the target's value date, and it must name the same account. That is all.

Specifically, it does **not**:

- delete or amend E7 — the ledger is append-only, and E7 remains a true statement about what was booked on Day 5;
- reverse the Day-5 overdraft fee — the fee was correctly assessed against what was known at that close, and reversing a debit is not authority to reverse a separately assessed charge;
- recreate interest that was not earned on Day 5 — no positive balance existed at that close, so no accrual was missed, only foregone;
- release any hold.

**Consequence, and it is the one the criteria get wrong.** The pre-E7 close on Day 4 was 465.00. After E9 the Day-6 close is 440.00, not 465.00 — the 25.00 fee stands. A design in which reversing an entry silently unwound every downstream consequence would be a design in which no published figure is ever final. Whether the fee *should* be waived is a customer-service decision, and it would arrive as its own credit event with its own authorization — not as a side effect of E9.

---

## 10. What "append-only" has to forbid to mean anything

"No event record is ever mutated or deleted" is easy to satisfy shallowly and easy to violate by accident. Ambiguity: how far does it reach?

**Resolution.** It reaches to the boundary. Concretely:

- Input is snapshotted and deeply frozen on the way in, so a caller keeping a reference to the object it passed cannot reach back and edit committed history.
- Validation completes **before** any sequence number, event id, or record is committed. A rejected append leaves the store byte-identical to before it, so a failed append is safely retryable and cannot burn an id.
- An event and its postings must name the same account, and currency identity is code **and** scale — `{AED,2}` and `{AED,3}` are not the same currency and are never silently reconciled.
- Face amounts are positive; direction comes from the event type. An event carrying a negative amount is a caller bug, not a clever debit.
- A day that has closed does not accept new events for that booked day. Without this the "assessed once per day" guarantee is unenforceable.

---

## 11. Two smaller resolutions, recorded so they are not mistaken for oversights

**No overdraft fee schedule exists for BHD.** The brief names AED 25.00 and is silent on BHD. The fee table is keyed by currency code and deliberately has no BHD entry, so an overdrawn BHD account raises a loud configuration error rather than a guessed amount. Converting AED 25.00 into BHD needs an FX rate this ledger does not have and must not invent. ACC-002 never goes negative here, so this path is unexercised in the replay — which is exactly why it must fail loudly rather than silently pick something.

**Opening balances are not events.** Both accounts open at zero. A zero-valued `ACCOUNT_OPENED` event would add a record that changes no balance and answers no question. Accounts are declared with their currency, and the opening balance is the empty sum. If an account ever opened at a non-zero balance that would be a real event and would need one.
