# Owner data file: <name of the file>

A data file of the owner (a price list, a list of costs, a table of rates, a set of expected values) is read by many and written by **one**. Fill this sheet once per file and keep it next to the file, or as its first lines when the format allows comments.

## 1. One writer

- **File:** `<path in the project>`
- **The one writer:** `<who writes it: the owner by hand, or one named command or order>`
- **Everyone else reads it.** An order that needs another value asks the writer; it never edits the file.

## 2. Never overwritten without comparing first

Before any write of this file:

1. Keep the current copy (git has it when the file is committed; if it is not, copy it under the order's evidence folder first).
2. Compare the new content with the current one and show the owner the difference in counts: rows added, removed, changed. Never the values in a report or a log when they are private.
3. Write only after that comparison was seen. A write that would change more rows than the order names is stopped and reported.

## 3. What each number means

| Column or key | What it means | Where it comes from | Unit |
|---|---|---|---|
| `<name>` | `<one plain sentence>` | `<the source: a supplier list, a rule, a decision of the owner, with its date>` | `<currency and whether tax is included, percent or fraction, per unit or per pack, …>` |

A number without its unit and its source is not data yet: the order that finds one stops and asks.

## 4. Expected values say which rule must produce them

When this file is a control (a list of expected results that a check compares with what the product computes), each item carries, next to the number:

| Item | Expected value | Unit | The rule expected to win |
|---|---|---|---|
| `<item>` | `<number>` | `<unit>` | `<the name of the rule that must produce this value: for example "minimum margin", "price list B", "rounding to 0.10">` |

A control that holds only numbers passes or fails without saying why. With the rule and the unit, a failure says which rule lost.

## 5. A control calls the function it controls

A guard, a check or a test of a computation builds its input and its result with **the same function the product uses**, never with a copy of its logic. The order says which function that is, and its verify file checks that the control imports it.
