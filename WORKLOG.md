# Worklog

Times are Asia/Dubai (`+04:00`). Entries from 12:21 onward match this repository's commit timestamps:

```bash
TZ=Asia/Dubai git log --reverse --date=format-local:'%Y-%m-%d %H:%M' --pretty='%ad  %s'
```

The earlier entries produced no commit — reading the brief and working the domain out on paper — so they are recorded here rather than inferred from git.

Reasoning lives in `AMBIGUITIES.md`, `REJECTED.md`, `NUMBERS.md` and `ARCHITECTURE.md`; this file is the timeline.

---

## 2026-09-06

| Time | Spent | Work |
|---|---|---|
| 10:50–12:20 | 1h30 | Read the brief; worked through the ambiguities and the six-day arithmetic by hand before writing anything. Settled fee timing, close ordering, reversal scope, and which acceptance criteria are wrong |
| 12:21 | | Scaffolded Bun + TypeScript, strict. One runtime dependency: `dinero.js` via its bigint entry point |
| 12:26 | | `AMBIGUITIES.md` — eleven ambiguities, written up before any code |
| 12:35 | | `money` — amounts at their currency's own precision, single-step rounding, conserving split. Tests first |
| 12:41 | | `ledger` — append-only bitemporal store. `balanceAsOf(account, valueDate, knownOn)`, both cutoffs required |
| 12:47 | | `engine` — authorization, settlement, credit, debit. Holds derived from the record log, not stored |
| 12:53 | | Day close and overdraft fee. Trigger reads the pre-fee balance; fee schedule keyed by currency, no BHD entry |
| 12:58 | | Interest — 0.04%/day on positive closes, capitalized on Day 6 as the sum of the stored accruals |
| 13:03 | | Reversal — negates its target's postings at the target's value date, and undoes nothing else |
| 13:12 | | Replay — E1…E10 in the literal feed order, then Days 1–6 closed in order. Six-day golden test over the real stream |
| 13:14 | | Acceptance — one test per criterion; the four rejected ones pinned to the behaviour that refutes them |
| 13:17 | | Report — `bun run replay` prints per day and account: events with decisions, closing balance, fee, interest, capitalized final |
| 13:20 | | Known-failing — the one deliberate failure: fee history depends on arrival order. Kept out of the green suite, annotated with why every fix is worse |
