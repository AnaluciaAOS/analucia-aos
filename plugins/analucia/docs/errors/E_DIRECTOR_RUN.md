# E_DIRECTOR_RUN

Who acts: `director`

## What happened

`aos run start` (or `aos resume-order`) was run from a session that declared the role director. A director never executes an order and never owns a run, so nothing was started and nothing was written.

## What to do next

**Leave the run to an executor: the owner opens another session for it, and this session keeps writing drafts.** (director)

1. Tell the owner, in one line, that the order is ready to run and needs an executor session.
2. In the executor session: `node plugins/analucia/bin/aos.mjs next` names the order to start.

## Patterns

- One session, one role: the director writes drafts in `.analucia/drafts/`; the executor runs one order by its ID.

## Trade-offs

- A person who works alone needs two sessions. In exchange, the stop hook never holds the director's session for a run it does not own.

## Gotchas

- The role is read from the latest `role.declared` of the session id; a session that never declared director is an executor.
- The stop hook blocks only the session that started the open run; other sessions are told which order is open and may end.
