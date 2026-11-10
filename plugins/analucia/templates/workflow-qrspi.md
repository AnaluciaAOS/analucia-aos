# Workflow template: QRSPI

An order may declare `workflow: qrspi` in its front matter (AMD-0007 §3). It is a template for how the work is done. It is **not** a lifecycle: the order keeps its states (`queued`, `active`, `delivered`, `verified`, `closed`, …) and the owner keeps the last word through `aos sign`. Without the key, nothing changes.

Attribution: the stage names (Questions, Research, Design, Structure, Plan, Implement) come from public HumanLayer material. No code from it is used.

## Stages

Each stage writes one document under `.analucia/artifacts/<ORDER>/` and registers it for the owner's review:

```
node plugins/analucia/bin/aos.mjs review request .analucia/artifacts/<ORDER>/<file> --order <ORDER>
```

| Stage | Document | What it holds |
|---|---|---|
| Questions | `questions.md` | What is not clear yet, written as questions the owner or the director can answer |
| Research | `research.md` | What was found in the code, the docs and the log, with where each fact comes from |
| Design | `design.md` | The chosen approach in plain words, and what was left out |
| Structure | `structure.md` | Files, data and commands that will change, and in what order |
| Plan | `plan.md` | The steps, the checks that prove each one and the order's budget |
| Implement | the code itself | The work, with evidence in `.analucia/evidence/<ORDER>/report.md` as for any order |

## The gate

`design.md` and `plan.md` need a current `approve` from the owner before the implementation counts. "Current" means the owner approved the exact content now on disk: any change to the file sends it back to the waiting list.

The director adds this check to the order's own verify file:

```json
{ "name": "design and plan approved", "run": "node plugins/analucia/bin/aos.mjs workflow check <ORDER>", "expect_exit": 0 }
```

`aos workflow check <ORDER>` prints one line per document and exits 0 when both have a current approve, 1 otherwise.

## When the owner comments or rejects

The note appears in `resume.md` under "Corrections to apply". The executor revises the document and runs `aos review request` again; it returns to the owner's list.
