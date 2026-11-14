# Closing test by a person: from an empty folder to a signed order

For the owner, or for a new person who has never used Analucia. One page. The question it answers:

**In a new empty folder, with no help from any outside chat, do you reach a signed order using only the plugin and clicks?**

You never type a command. If a step makes you type one, **stop there**: that is the result of the test. Typing a number, a short answer or one of the words `CONFIRM`, `PLACE`, `CLOSE` **inside a window that a launcher opened** is not a command: it is your signature.

## Before you start (once per computer)

- [ ] Node.js 20 or newer and Git are installed.
- [ ] Claude Code is installed, and the Analucia plugin is installed in it for every folder ("user" scope). A plugin installed for one project only does not load in a new folder.

Installing these is not part of this test (a one-click installer is a later piece of work). Write down if you needed help with it.

## The steps

| # | Who | What you do | What you should see |
|---|---|---|---|
| 1 | You | Create a new empty folder and open it in Claude Code. | The session starts with one line that says the folder is not initialised and what comes next. |
| 2 | You, in the Claude Code chat | Say: **"Start Analucia in this folder."** | The session writes five launchers in the folder: `INICIAR`, `FIRMAR`, `DETENER`, `REANUDAR`, `IMPORTAR` (on Windows, the `.cmd` files). It cannot press them. |
| 3 | You, by click | Double-click **INICIAR**. Answer the 15 questions with a number each. Type `CONFIRM`. | A window opens and stays open. At the end: "Applied." and a list of checks. Press a key to close it. |
| 4 | You, in the Claude Code chat | Ask for something small, for example: **"I need a file hello.txt with one line. Prepare the order."** | The session writes a draft order and tells you, in one line, that an order waits for you. It has not started the work. |
| 5 | You, by click | Double-click **FIRMAR**. Read the title of the draft. Type `PLACE`. | "Placed and queued: ORD-0001. The executor can start." |
| 6 | You, in the Claude Code chat | Say: **"Run ORD-0001."** | The session does the work, writes its report and says the order is delivered. It cannot sign it. |
| 7 | You, by click | Double-click **FIRMAR**. Look at the checks. Type `CLOSE`. | Each check shows "passed", then "Signed: ORD-0001." |

At any moment, to know what comes next: ask the session **"What is next?"** It answers with one line (`aos next`) that names the next step, who does it and which launcher to double-click.

## If something goes wrong

- A window closes at once, or says the plugin or Node.js was not found: stop, and write down the step and the words on the screen.
- The session asks you to copy a command into a terminal: stop. That is a result: write down which command.
- To stop every agent: double-click **DETENER** and write one line with the reason. To let them work again: **REANUDAR**.

## What to write down

- Date, who did the test, and the computer (Windows, macOS or Linux).
- One line, exactly one of:
  - `Closing test by a person: reached a signed order`
  - `Closing test by a person: stops at step N` — with what you saw and what you were asked to do.
- How many times you clicked, how many times you wrote in the chat, and how many commands you typed (the goal is 0).
- How long it took, from step 1 to the end.

Give these notes to the director: they go in the report of the order that follows ORD-0040.

## Limits known today

- The launchers are `.cmd` (Windows) and `.sh` (Linux, macOS from a terminal). On macOS a double-click on a `.sh` file opens an editor, not a terminal: that is a stop at step 3, to be reported.
- In a folder that is not a git repository the signature is recorded in the event log only; nothing is sent to GitHub.
- The answers of a question (`aos ceo export` / **IMPORTAR**) are not part of this test.
