// Error registry (SPEC-0003 §2): every code the tools can emit -> { next, who }.
// next = one imperative sentence: what to do now. who = the role that must do it.
// Each code has a page: plugins/analucia/docs/errors/<CODE>.md (aos explain <CODE>).
import { renderCommands } from './cli.mjs';

export const ERRORS = {
  E_ACCOUNT: { who: 'owner', next: 'Point the remote URL user and credential.https://github.com.username at the github_owner of .analucia/project.json, then push again.' },
  E_ACTOR_ENUM: { who: 'executor', next: 'Use one of the actors values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_ADOPT_UNAVAILABLE: { who: 'owner', next: 'Run aos adopt inside the git work tree of the project (it needs the repository and its history).' },
  E_ANSWER_VALUE: { who: 'owner', next: 'Fix the named answer to one of the allowed values (or write unknown to use the safe default) and run aos init again.' },
  E_ASK_KIND_ENUM: { who: 'director', next: 'Use one of the ask_kinds values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_ASK_TOO_LONG: { who: 'director', next: 'Shorten the question in the ask file to at most 600 characters and move details to refs.' },
  E_BACKUP: { who: 'executor', next: 'Read the git step named in the message, fix it (remote reachable, account, a git work tree), then run aos backup again.' },
  E_BLOCKED_NO_REF: { who: 'executor', next: 'Give the blocked transition a blocked_by value (an ask, order or decision ID, or a reason) and record it again.' },
  E_BUDGET: { who: 'director', next: 'Decide what happens to the order (amend its budget or issue a new order); the executor stops.' },
  E_CHAIN: { who: 'director', next: 'Restore .analucia/events.jsonl from git and confirm with aos verify-log; nobody edits the log by hand.' },
  E_COST_EFFECT_ENUM: { who: 'director', next: 'Set cost_effect to one or more of none, build, deploy, service, data (cost_effects in plugins/analucia/core/enums.json).' },
  E_DECISION_ENUM: { who: 'director', next: 'Use one of the admission_decisions values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_DIRECTOR_FILE_CHANGED: { who: 'director', next: 'Restore the listed director files from git, or re-issue them and refresh .analucia/director.lock.' },
  E_DUPLICATE_KEY: { who: 'director', next: 'Remove the repeated key from the front matter so each key appears once.' },
  E_EVIDENCE_ENUM: { who: 'executor', next: 'Use one of the evidence_levels values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_FIELD_TYPE: { who: 'director', next: 'Change the value named in the message to the stated type (date YYYY-MM-DD, positive integer, inline list, object or string).' },
  E_FILE_MISSING: { who: 'executor', next: 'Create or point to the file named in the message; if it is a director file, finish the run with needs_decision.' },
  E_FILE_TYPE: { who: 'executor', next: 'Run aos validate on a project directory or on an order, verify file, director.lock, project.json or events.jsonl.' },
  E_FRONT_MATTER: { who: 'director', next: 'Rewrite the order front matter as flat key: value lines between two --- lines.' },
  E_ID_FORMAT: { who: 'director', next: 'Use an ID of the right format: ORD-0000 or ORD-0000.A for orders, a 26-character ULID for events.' },
  E_ID_MISMATCH: { who: 'director', next: 'Make the id (or order) field equal the file name without its extension.' },
  E_JSON: { who: 'director', next: 'Fix the JSON syntax at the line named in the message (project.json, a verify file, the lock, or one event line).' },
  E_KIND_ENUM: { who: 'director', next: 'Set kind to one of the order_kinds in plugins/analucia/core/enums.json.' },
  E_MISSING_FIELD: { who: 'director', next: 'Add the required field named in the message and run aos validate again.' },
  E_MOVING_REF: { who: 'director', next: 'Replace the moving ref named in the message (HEAD, a branch or a remote ref) with a commit SHA or {order_commit} in the verify file, then run aos validate again.' },
  E_NOT_CONFIRMED: { who: 'owner', next: 'Run aos close again in your terminal and type CLOSE exactly to sign.' },
  E_NOT_LOCKED: { who: 'director', next: 'Add the order file and its sha256 (LF-normalized) to .analucia/director.lock, then run aos admit again.' },
  E_NO_ACCEPTANCE: { who: 'director', next: 'Add a ## Acceptance criteria section with at least one list item to the order.' },
  E_NO_ORDER: { who: 'director', next: 'Write the order file .analucia/orders/ORD-NNNN.md; the executor does no work without it.' },
  E_NO_ORDER_COMMIT: { who: 'executor', next: 'Commit with the trailer Analucia-Order: ORD-NNNN of the order, then ask for verify.' },
  E_NO_ORDER_TRAILER: { who: 'executor', next: 'Amend the listed commit so its message ends with the trailer Analucia-Order: ORD-NNNN of the order you are running, then push again.' },
  E_NO_ROLLBACK: { who: 'director', next: 'Write the rollback plan .analucia/rollback/ORD-NNNN.md, name it in the order rollback key and list it in director.lock.' },
  E_OUTCOME_ENUM: { who: 'executor', next: 'Use one of the run_outcomes values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_OWNER_TTY: { who: 'owner', next: 'Run the command yourself in your own interactive terminal; agents stop here.' },
  E_PAUSED_NO_REASON: { who: 'executor', next: 'Record the pause again with a reason in the payload.' },
  E_POLICY_ENUM: { who: 'owner', next: 'Set deploy.policy in .analucia/project.json to one of the deploy_policies (batch or continuous).' },
  E_PREV_FORMAT: { who: 'director', next: 'Restore .analucia/events.jsonl from git; prev values are written only by aos.' },
  E_RECORD_EXISTS: { who: 'director', next: 'Use a new record ID; IDs are never created twice or reused.' },
  E_REF_FORMAT: { who: 'director', next: 'Replace the reference with a valid record ID (ORD-0000, DEC-0000, SPEC-0000, OBS-0000, AMD-0000, ASK-0000).' },
  E_REVIEW_DECISION: { who: 'owner', next: 'Type approve, comment or reject (comment and reject need a note) for a document that is waiting, in aos sign.' },
  E_REVIEW_PATH: { who: 'executor', next: 'Register a document that lives inside the project, with a path relative to its root, then run aos review request again.' },
  E_RISK_CLOSE: { who: 'owner', next: 'Close this order yourself from your own terminal with aos close ORD-NNNN; only risk: low orders may be closed with --as director.' },
  E_RISK_ENUM: { who: 'director', next: 'Set risk in the order to low, medium or high (risk_levels in plugins/analucia/core/enums.json).' },
  E_ROLES: { who: 'director', next: 'Run aos agents-md sync and keep CLAUDE.md to the line @AGENTS.md, with director instructions moved to the director entrypoint.' },
  E_SECRET: { who: 'owner', next: 'Remove the secret from the listed commit and file, rotate it at its provider, then push again.' },
  E_SECRET_IN_URL: { who: 'owner', next: 'Remove the credential from the remote URL with git remote set-url, rotate it, then push again.' },
  E_SHEET_VALUE: { who: 'owner', next: 'Fix the listed cells in the owner sheet (or export a fresh one with aos ceo export) and run aos ceo import again.' },
  E_STATE_ENUM: { who: 'executor', next: 'Use one of the order_states values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_STATE_IN_DEFINITION: { who: 'director', next: 'Remove the state key from the order file; state is derived from the event log.' },
  E_SUPERSEDED_NO_REF: { who: 'director', next: 'Record the transition to superseded with payload.superseded_by set to the replacing record ID.' },
  E_TRANSITION: { who: 'executor', next: 'Read the order state with aos history ORD-NNNN and use the command or transition allowed from that state.' },
  E_TS_FORMAT: { who: 'director', next: 'Restore .analucia/events.jsonl from git; timestamps are set by aos.' },
  E_TYPE_ENUM: { who: 'executor', next: 'Use one of the event_types values from plugins/analucia/core/enums.json and write the event again with aos event append.' },
  E_UNKNOWN_CODE: { who: 'executor', next: 'Run aos explain with one of the close matches it listed.' },
  E_UNKNOWN_KEY: { who: 'director', next: 'Remove the key named in the message or rename it to an allowed key.' },
  E_VERIFY_FAILED: { who: 'director', next: 'Read the verify evidence file and send the order back for rework or amend it; the order stays delivered.' },
  E_WIP_LIMIT: { who: 'executor', next: 'Finish the active order first with aos run finish, or wait; only the owner raises wip_limit.' },
  E_WORKFLOW_ENUM: { who: 'director', next: 'Remove the workflow key or set it to qrspi, then refresh director.lock.' },
};

const UNREGISTERED = { who: 'director', next: 'Add this code to plugins/analucia/lib/errors.mjs and write its page.' };

// The next step as printed: "aos <command>" and plugin paths become what exists on this machine (ORD-0029 B).
export const renderedNext = (code) => renderCommands((ERRORS[code] ?? UNREGISTERED).next);

// The second line of every printed error.
export function nextLine(code) {
  const e = ERRORS[code] ?? UNREGISTERED;
  return `  next (${e.who}): ${renderedNext(code)} — see docs/errors/${code}.md`;
}

// First line unchanged, plus the next line.
export const withNext = (firstLine, code) => `${firstLine}\n${nextLine(code)}`;
