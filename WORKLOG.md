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
