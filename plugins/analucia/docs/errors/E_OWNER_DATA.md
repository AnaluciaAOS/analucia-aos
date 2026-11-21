# E_OWNER_DATA

Who acts: `executor`

## What happened

A tool call tried to write or delete a file that `owner_data` in `.analucia/project.json` lists: a file only the owner writes (prices, costs, rates, expected values, a control file). The hook refused it, for every agent role. Reading stays free.

## What to do next

**Do not write the file: tell the owner what should change in it and why; only the owner writes the files listed in owner_data.** (executor)

1. Say, in the report or to the owner, which line of the file should change, to what, and which rule or source says so.
2. Go on with the rest of the order; the file is the owner's to change.
3. If the order cannot be done without that change, say so in the report: the owner decides at the signature.

## Patterns

- `owner_data` is a list of path patterns relative to the project root: `data/prices.csv`, `controls/*.xlsx`, `owner/**`. `*` stops at a slash, `**` does not; a pattern with no slash (`rates.*`) names a file at any depth.
- The owner names the files when `aos init` asks, and may change the list later in the answers file of `aos init` or in its interview.
- A control that reads the file calls the function the product uses; it never rewrites the file with the output of the engine it controls.

## Trade-offs

- The hook judges the path a tool call names: a script that builds the path itself (or a program that writes the file as a side effect) is not seen by it. The rule is still the same: nobody but the owner writes that file.

## Gotchas

- A copy of the file in another folder is not the file: write copies for a trial only in a scratch folder, and record real data copies with `aos scratch add`.
- A path outside the project is not judged by this hook.
