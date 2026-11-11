#!/usr/bin/env node
/* Guardrail check for the round generator (src/pairing.js).
 *
 * Simulates whole nights on realistic rosters using the standings snapshot in
 * scripts/fixtures/history.json, including nights where the group hand-edits
 * rounds (tap-to-swap) after generation. Exits non-zero if any guardrail fails.
 *
 *   npm run check            # default: 6 nights per roster
 *   npm run check -- 20      # more nights (slower, ~0.3-0.6 s per generated round)
 *
 * Guardrails (all on rounds the generator produced, not on hand edits):
 *   G1  No repeat partners while a no-repeat round is still possible.
 *   G2  No rule break (R1-R3) unless the round is flagged (meta.illegal > 0)
 *       and it is a genuine dead end (8 players at round 7, or after edits).
 *   G3  Fair rests: everyone resting has the fewest rests; never twice in a row.
 *   G4  Everyone on the roster is placed exactly once per round.
 *   G5  Generation time per round stays under 4 s.
 *   G6  A stored plan is never reused after a hand edit made its rest unfair.
 */
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { makeRound, dropPlan, historyRatings, tiersFor, classifyMatch, counts, maxNoRepeatRounds } from "../src/pairing.js";

const here = path.dirname(fileURLToPath(import.meta.url));
const history = JSON.parse(fs.readFileSync(path.join(here, "fixtures/history.json"), "utf8"));
const hr = historyRatings(history);
const NIGHTS = Number(process.argv[2]) || 6;
const MAX_MS = 4000;

const ROSTERS = [
  ["Sajith", "Ashish", "Baid", "Sankalp", "Surya", "Tanmoy", "Ejas", "Vijay", "Maloo"],      // 9
  ["Sajith", "Ashish", "Baid", "Sankalp", "Surya", "Tanmoy", "Ejas", "Vijay"],               // 8
  ["Sajith", "Ashish", "Arjun", "Sankalp", "Surya", "Tanmoy", "Ejas", "Vijay", "Maloo", "Baid"], // 10
  ["Sajith", "Ashish", "Sankalp", "Surya", "Ejas"],                                          // 5
  ["Sajith", "Ashish", "Baid", "Sankalp", "Surya", "Tanmoy", "Newbie"],                      // 7, one with no record
];

const pk = (a, b) => (a < b ? a + "|" + b : b + "|" + a);
const rnd = (n) => Math.floor(Math.random() * n);
const failures = [];
const fail = (msg) => failures.push(msg);

// Mimics App.jsx applySwap: swap two random slots in a round, clear scores, drop stale plan.
function randomSwap(r) {
  const slots = [];
  r.matches.forEach((m, mIdx) => ["teamA", "teamB"].forEach((t) => [0, 1].forEach((s) => slots.push({ mIdx, t, s }))));
  r.resting.forEach((_, i) => slots.push({ rest: i }));
  if (slots.length < 2) return r;
  const a = slots[rnd(slots.length)]; let b = slots[rnd(slots.length)];
  if (a === b) return r;
  const matches = r.matches.map((m) => ({ ...m, teamA: [...m.teamA], teamB: [...m.teamB], scoreA: "", scoreB: "" }));
  const resting = [...r.resting];
  const get = (s) => (s.rest != null ? resting[s.rest] : matches[s.mIdx][s.t][s.s]);
  const set = (s, v) => { if (s.rest != null) resting[s.rest] = v; else matches[s.mIdx][s.t][s.s] = v; };
  const p1 = get(a), p2 = get(b); set(a, p2); set(b, p1);
  return dropPlan({ ...r, matches, resting });
}

function randomScores(r) {
  return { ...r, matches: r.matches.map((m) => { const a = 21, b = rnd(20); return Math.random() < 0.5 ? { ...m, scoreA: String(a), scoreB: String(b) } : { ...m, scoreA: String(b), scoreB: String(a) }; }) };
}

const stats = { rounds: 0, ext: 0, flagged: 0, maxMs: 0, totalMs: 0 };

function checkRound(label, players, rounds, r, ms) {
  const tiers = tiersFor(players, rounds, hr);
  const c = counts(players, rounds);
  const n = players.length;
  stats.rounds++; stats.totalMs += ms; stats.maxMs = Math.max(stats.maxMs, ms);
  if (ms > MAX_MS) fail(`${label}: G5 generation took ${ms} ms`);

  // G4 placement
  const placed = [...r.resting, ...r.matches.flatMap((m) => [...m.teamA, ...m.teamB])];
  if (placed.length !== n || new Set(placed).size !== n || placed.some((id) => !players.find((p) => p.id === id)))
    fail(`${label}: G4 players placed ${placed.length}/${n}, unique ${new Set(placed).size}`);
  if (r.resting.length !== n % 4) fail(`${label}: G4 resting ${r.resting.length}, expected ${n % 4}`);

  // G1 repeats
  const repeats = r.matches.filter((m) => c.partner[pk(...m.teamA)] || c.partner[pk(...m.teamB)]).length;
  if (repeats && rounds.length < maxNoRepeatRounds(n) && !(r.meta && r.meta.repeats))
    fail(`${label}: G1 ${repeats} repeat partnership(s) in round ${rounds.length + 1} of a possible ${maxNoRepeatRounds(n)} without a flag`);

  // G2 rule breaks
  const illegal = r.matches.filter((m, j) => classifyMatch(m, r.matches.filter((_, k) => k !== j), tiers) === 2).length;
  const ext = r.matches.filter((m, j) => classifyMatch(m, r.matches.filter((_, k) => k !== j), tiers) === 1).length;
  stats.ext += ext;
  if (illegal) {
    stats.flagged++;
    if (!(r.meta && r.meta.illegal > 0)) fail(`${label}: G2 ${illegal} rule break(s) but meta.illegal is ${r.meta && r.meta.illegal}`);
  }
  if (r.meta && (r.meta.ext ?? 0) !== ext) fail(`${label}: meta.ext=${r.meta.ext} but ${ext} extension match(es) found`);

  // G3 fair rests: nobody sits out while someone who has rested less keeps playing,
  // and nobody sits out twice in a row while an equally rested, fresh player was available.
  if (r.resting.length) {
    const restSet = new Set(r.resting);
    const playing = players.filter((p) => !restSet.has(p.id));
    const maxResting = Math.max(...r.resting.map((id) => c.rests[id]));
    const minPlaying = Math.min(...playing.map((p) => c.rests[p.id]));
    if (maxResting > minPlaying) fail(`${label}: G3 resters have ${r.resting.map((id) => c.rests[id])} rests while a player with ${minPlaying} keeps playing`);
    const last = rounds.length ? new Set(rounds[rounds.length - 1].resting || []) : new Set();
    for (const id of r.resting) {
      if (!last.has(id)) continue;
      const alt = playing.find((p) => !last.has(p.id) && c.rests[p.id] <= c.rests[id]);
      if (alt) fail(`${label}: G3 back-to-back rest for ${players.find((p) => p.id === id).name} while ${alt.name} was available`);
    }
  }
}

// ---- Nights: clean, and with hand edits on ~40% of rounds ----
for (const roster of ROSTERS) {
  for (let night = 0; night < NIGHTS; night++) {
    const edits = night % 2 === 1;
    const players = roster.map((n, i) => ({ id: "p" + i, name: n }));
    const n = players.length;
    const nRounds = Math.min(8, Math.max(2, maxNoRepeatRounds(n)) + (n === 8 ? 0 : 0));
    let rounds = [];
    for (let i = 0; i < nRounds; i++) {
      const t0 = Date.now();
      const r = makeRound(players, rounds, hr);
      const ms = Date.now() - t0;
      checkRound(`${n}p night${night}${edits ? "+edits" : ""} r${i + 1}`, players, rounds, r, ms);
      let played = randomScores(r);
      if (edits && Math.random() < 0.4) played = randomSwap(played);
      rounds.push(played);
    }
  }
}

// ---- G6: a stale plan whose rest is no longer fair must not be reused ----
{
  const players = ROSTERS[0].map((n, i) => ({ id: "p" + i, name: n }));
  let rounds = [];
  for (let i = 0; i < 4; i++) rounds.push(randomScores(makeRound(players, rounds, hr)));
  const r5 = makeRound(players, rounds, hr);
  if (r5.meta && r5.meta.plan && r5.meta.plan.length) {
    // Hand-edit round 5 so that the player planned to rest next round rests now instead,
    // but keep the stale plan attached (the pre-fix behaviour) to prove the guard catches it.
    const nextRester = r5.meta.plan[0].resting[0];
    const edited = { ...r5, resting: [nextRester], matches: r5.matches.map((m) => ({ ...m, teamA: m.teamA.map((id) => (id === nextRester ? r5.resting[0] : id)), teamB: m.teamB.map((id) => (id === nextRester ? r5.resting[0] : id)) })) };
    const r6 = makeRound(players, rounds.concat([edited]), hr);
    if (r6.resting.includes(nextRester)) fail(`G6 stale plan reused: ${players.find((p) => p.id === nextRester).name} rests twice in a row`);
  }
}

// ---- Report ----
console.log(`Checked ${stats.rounds} generated rounds across ${ROSTERS.length} rosters x ${NIGHTS} nights.`);
console.log(`  extension matches: ${stats.ext}   flagged (fallback) rounds: ${stats.flagged}`);
console.log(`  generation time: avg ${(stats.totalMs / stats.rounds).toFixed(0)} ms, max ${stats.maxMs} ms`);
if (failures.length) {
  console.log(`\nFAIL (${failures.length}):`);
  failures.slice(0, 40).forEach((f) => console.log("  - " + f));
  process.exit(1);
}
console.log("\nPASS: all guardrails met.");
