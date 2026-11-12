# Marina Smashers — context for every agent

Doubles badminton night app for a Dubai group. React 18 + Vite, deployed by Vercel from
`main` to marinasmash.com (about 30 s after a push). Shared data lives in one Supabase
Postgres table `kv` (keys `badminton:session:v3`, `badminton:history:v3`,
`badminton:roster:v3`, `badminton:signups:v3`, `badminton:bookings:v3`, `badminton:lock:v3`)
with public read/write policies. There is no backend code.

## Files that matter
- `src/pairing.js` — the round generator. Pure functions, no React. Read its header comment first.
- `src/App.jsx` — the whole UI (one file). Rounds are generated in `addRound`, rerolled in
  `rerollRound`, hand-edited in `applySwap`, deleted in `deleteRound`.
- `src/storage.js` — Supabase `kv` get/set and photo upload.
- `scripts/check-guardrails.mjs` — simulation on 5/8/9/10-player nights that asserts the pairing guardrails (`npm run check`).
- `scripts/fixtures/history.json` — standings snapshot used by the check.
- `README.md` — user-facing docs, including “How rounds are paired” and the agent workflow.

## Roster sizes
Nights have 5, 8, 9 or 10 players. No other size occurs, so do not design, test or document
for 6 or 7 (the code tolerates them, nothing more).

## Pairing rules (must never regress)
Tiers come from all-time point difference per game in History: top 4 Strong, next 2 Mid,
rest Weak (smaller splits below 8 players; history trusted after 6 games; `abhishek` = `baid`).
1. No repeat partners in a session (hard).
2. Strong+Strong only plays Strong+Strong.
3. Strong+Weak only plays Strong+Weak or Strong+Mid.
4. Weak+Weak only plays Mid+Weak, and only beside a Strong+Strong v Strong+Strong court.
5. Fair rests: fewest rests sit out first, never twice in a row when avoidable.
6. Extension match-ups (S+M v S+M, S+M v M+W, S+W v M+M, M+W v M+W) allowed but discouraged.
The generator plans the whole night ahead (`meta.plan`), re-plans after a hand edit
(`dropPlan`), and falls back to the fewest-violation round, flagged in `meta.illegal`.

## Commands
- `npm install` then `npm run build` — must pass before any push.
- `npm run check` — guardrail simulation, exits 1 on failure. `npm run check -- 20` for a longer run.
- No unit-test runner; verify pairing changes with node scripts that import `src/pairing.js`.
- Live data: the Supabase connector is usually blocked here. Load https://www.marinasmash.com
  in headless Chromium (Playwright is pre-installed) and capture the `/rest/v1/kv` responses.

## Branch and merge policy
- Work on the session's designated `claude/...` branch. Never push to `main` directly.
- `main` is only fast-forwarded after a human says so in chat. The reviewer agent merges
  only when the lead's message contains the literal phrase `HUMAN APPROVED MERGE`.
- Commit messages: imperative subject, body explains why. No model names in any artifact.

## Agent workflow
Use `/ship-feature <task>` to run the lead → coder → tester → reviewer pipeline described in
`.claude/skills/ship-feature/SKILL.md`. Agent roles are in `.claude/agents/`.
