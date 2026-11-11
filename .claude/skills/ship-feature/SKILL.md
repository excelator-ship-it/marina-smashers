---
name: ship-feature
description: Run the lead → coder → tester → reviewer pipeline for a change to the Marina Smashers app. Use when the user asks to build, change or fix something in the app and wants it coded, tested, reviewed and merged after their approval.
---
You are the lead. You gather context and write the brief; sub-agents do the coding, testing and
reviewing. Do not code the change yourself. The task is in `$ARGUMENTS`.

## 1. Gather context
- Read `CLAUDE.md`, then the files the task touches (`src/pairing.js`, `src/App.jsx`, `README.md`).
- If the task depends on real data (standings, a past night), capture it from the live site with
  headless Chromium as `CLAUDE.md` describes, and summarise the relevant numbers.
- Decide the branch: the session's designated `claude/...` branch. Confirm it exists on origin or
  will be created from `origin/main`.

## 2. Write the brief
A brief is self-contained; the sub-agent sees nothing else. Include:
- Goal in two sentences and why (what went wrong, or what the user wants).
- Files to change, by repository path, and what in each.
- Acceptance criteria as a numbered list the tester can check mechanically.
- Guardrails that must not regress (point at the rules section of `CLAUDE.md`).
- The branch name, and that `npm run build` and `npm run check` must pass.
Show the brief to the user in your message before spawning agents.

## 3. Coder
Spawn `coder` (subagent_type: coder) with the brief. Wait for its report. If it reports a failing
build or check, send it the output and ask for a fix; after two failed rounds stop and tell the user.

## 4. Tester
Spawn `tester` with the brief, the branch and the coder's reported commit hash. If it reports FAIL,
send the tester's findings to the coder (SendMessage keeps its context), then re-run the tester on
the new commit. Allow at most two coder→tester loops before stopping and reporting to the user.

## 5. Reviewer and human approval
Spawn `reviewer` with the brief, branch, coder report and tester report, without approval. Relay
its merge summary and findings to the user. If it says CHANGES NEEDED, route them to the coder and
re-test. Then ask the user, in one question, whether to merge to main.
Only if the user clearly says yes: message the reviewer with `HUMAN APPROVED MERGE` plus the branch.
Relay its deploy verification. If the user says no or asks for changes, do that instead.

## 6. Close
Final message to the user: what changed (commit hashes), what the tester verified, what the
reviewer found, whether main was merged and the deploy confirmed, and any open items.
