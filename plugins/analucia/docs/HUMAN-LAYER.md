# Reviewing documents and following sessions

For the owner. What changes for you with AMD-0007, in plain words.

## You review documents in one place

Sometimes the agent writes a document before it builds: a plan, a design, a mockup. It asks you to look at it. You do not need to know where the file is.

1. Double-click FIRMAR, or run `aos sign` in your own terminal.
2. Before the finished work, you see the documents waiting for you: the title, the order it belongs to and one line that says what it is about.
3. For each one, type:
   - `approve` if it is good;
   - `comment` if something should change (you write what);
   - `reject` if it should not go ahead (you write why);
   - `open` to see it first;
   - nothing (just Enter) to decide later.

Your answer is kept with the exact content you saw. If the agent changes the document afterwards, it comes back to you: an old "approve" never covers a new version.

Approving a document does not close an order. Closing still needs `CLOSE`, as before.

## Your notes reach the agent

When you comment or reject, the agent sees your note the next time it starts, under "Corrections to apply". It revises the document and asks you again.

## You see when a session was cut off

A session is one window where an agent works. An order can take several. When a session stops without ending properly (a closed window, a crash), the summary at the start of the next session shows it as **interrupted**, with the order and the one command to continue it. If a session ended while an order was still being worked on, that is shown too.

Nothing about the order itself changes: its states and your signature stay the same.

## Some orders follow a fixed sequence

An order may say `workflow: qrspi`. Then the agent first writes questions, research, a design, a structure and a plan, and you approve the design and the plan before the building counts. See `plugins/analucia/templates/workflow-qrspi.md`.

## Before a new order, the open ones

When the director prepares a new order, the tool first lists the orders that are still open, with this reminder: "If this is a correction or an extension of one of these, write an addendum to it instead of a new order." It is a reminder only; it never stops anything.

## When the director writes you a decision brief

When the director needs a decision from you that is bigger than "approve this document" (spending money, a new service, a change you cannot easily undo), they write a one-page **decision brief**. It says the idea in one sentence, why now, what changes for you, two or three options with their cost and risk, the one they recommend and why, exactly what they need from you, how to undo it, and where each fact comes from.

It reaches you like any other document: in `aos sign`, where you type `approve`, `comment` or `reject`. When you type `open`, it appears as a clean page, not as raw text. The templates are `plugins/analucia/templates/decision-brief.md` (English) and `decision-brief.es.md` (Spanish).

## If a computer is lost

`aos backup` saves the current work, including what is not committed yet, to a backup branch on GitHub. It never changes the work in progress. `docs/RECOVERY.md` explains how to get a working project back on a new computer in about an hour. Passwords and keys are not in any backup: they live in your password manager.

## Commands, for reference

- `aos review request <file> --order ORD-NNNN`: the agent asks for your review.
- `aos sign`: you decide (documents first, then finished orders).
- `aos workflow check ORD-NNNN`: shows whether the design and the plan of a QRSPI order are approved.
- `aos backup`: saves the current work to a backup branch; `aos backup --restore-hint` shows how to bring it back.
