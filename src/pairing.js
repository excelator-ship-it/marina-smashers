/* Marina Smashers — rule-ordered round generator.
 *
 * Players are tiered from their all-time record (History tab) into
 * Strong / Mid / Weak, and each new round is chosen by these rules, in order:
 *
 *   R4  No two players partner twice in a session.            (hard)
 *   R1  Strong+Strong may only play Strong+Strong.            (hard)
 *   R2  Strong+Weak may only play Strong+Weak or Strong+Mid.  (hard)
 *   R3  Weak+Weak may only play Mid+Weak, and only when the
 *       other court that round is Strong+Strong v Strong+Strong. (hard)
 *   —   Fair rests: fewest rests sit out first, never twice in a row.
 *   —   "Extension" match-ups the rules don't name (Strong+Mid v Strong+Mid,
 *       Strong+Mid v Mid+Weak, Strong+Weak v Mid+Mid, Mid+Weak v Mid+Weak)
 *       are allowed but discouraged. They are needed whenever a Strong
 *       player is resting — the strict rules alone cannot fill that round.
 *   —   Tie-break: closest team ratings, then opponent variety.
 *
 * The generator looks one round ahead so it does not paint itself into a
 * corner where every remaining pairing would break a rule. If no rule-clean
 * round exists at all (e.g. 4 players on round 2), it returns the round with
 * the fewest violations and flags it, rather than refusing.
 */

/* ---------------- ratings & tiers ---------------- */

// Same person, different spellings in the history. Lower-case on both sides.
const ALIASES = { abhishek: "baid", abhisekh: "baid" };
const norm = (name) => {
  const n = String(name || "").trim().toLowerCase();
  return ALIASES[n] || n;
};

// All-time point difference per game, from the saved week-by-week standings.
// Returns { [normalisedName]: { diff, games, rating } }.
export function historyRatings(history) {
  const acc = {};
  (history || []).forEach((h) => {
    (h.standings || []).forEach((s) => {
      const g = (s.wins || 0) + (s.draws || 0) + (s.losses || 0);
      if (!g) return;
      const k = norm(s.name);
      acc[k] = acc[k] || { diff: 0, games: 0 };
      acc[k].diff += Number(s.diff) || 0;
      acc[k].games += g;
    });
  });
  const out = {};
  for (const k in acc) out[k] = { ...acc[k], rating: acc[k].diff / acc[k].games };
  return out;
}

// Within-session point difference per game (what the old generator used).
function sessionRatings(rounds) {
  const acc = {};
  (rounds || []).forEach((rd) =>
    rd.matches.forEach((m) => {
      const a = m.scoreA === "" ? null : Number(m.scoreA);
      const b = m.scoreB === "" ? null : Number(m.scoreB);
      if (a == null || b == null || isNaN(a) || isNaN(b)) return;
      m.teamA.forEach((id) => { acc[id] = acc[id] || { d: 0, g: 0 }; acc[id].d += a - b; acc[id].g++; });
      m.teamB.forEach((id) => { acc[id] = acc[id] || { d: 0, g: 0 }; acc[id].d += b - a; acc[id].g++; });
    })
  );
  return acc;
}

const MIN_HISTORY_GAMES = 6; // fewer than this and the all-time number is too noisy to tier on

// Tier split: the top 4 are Strong (fewer in small groups), the next 2 are Mid, the rest Weak.
export function tierCounts(n) {
  if (n >= 8) return { S: 4, M: 2 };
  if (n >= 6) return { S: 3, M: 1 };
  if (n === 5) return { S: 2, M: 1 };
  return { S: 2, M: 1 }; // 4 players
}

// { [id]: { tier: "S"|"M"|"W", rating, games, source: "history"|"session"|"none" } }
export function tiersFor(players, rounds, hist) {
  const sess = sessionRatings(rounds);
  const info = players.map((p) => {
    const h = hist && hist[norm(p.name)];
    const s = sess[p.id];
    if (h && h.games >= MIN_HISTORY_GAMES) {
      // history anchors the tier; blend in tonight's games for the balance tie-break
      const g = h.games + (s ? s.g : 0);
      const rating = (h.diff + (s ? s.d : 0)) / g;
      return { id: p.id, tierKey: h.rating, rating, games: h.games, source: "history" };
    }
    if (s && s.g) return { id: p.id, tierKey: s.d / s.g, rating: s.d / s.g, games: s.g, source: "session" };
    return { id: p.id, tierKey: 0, rating: 0, games: 0, source: "none" };
  });
  const ordered = info.slice().sort((a, b) => b.tierKey - a.tierKey);
  const { S, M } = tierCounts(players.length);
  const out = {};
  ordered.forEach((x, i) => {
    out[x.id] = { tier: i < S ? "S" : i < S + M ? "M" : "W", rating: x.rating, games: x.games, source: x.source };
  });
  return out;
}

/* ---------------- legality (rules R1–R3) ---------------- */

const STRICT = new Set(["SS|SS", "SW|SW", "MS|SW"]);       // R1, R2
const CONDITIONAL = "MW|WW";                                 // R3 — needs an SS|SS court alongside
const EXTENSION = new Set(["MS|MS", "MS|MW", "MM|SW", "MW|MW"]);

const teamType = (team, tiers) => team.map((id) => tiers[id].tier).sort().join("");
export const matchKey = (m, tiers) => [teamType(m.teamA, tiers), teamType(m.teamB, tiers)].sort().join("|");

// 0 = allowed by the rules, 1 = extension (allowed, discouraged), 2 = breaks a rule
export function classifyMatch(m, others, tiers) {
  const k = matchKey(m, tiers);
  if (STRICT.has(k)) return 0;
  if (k === CONDITIONAL) return others.some((o) => matchKey(o, tiers) === "SS|SS") ? 0 : 2;
  if (EXTENSION.has(k)) return 1;
  return 2;
}

// Human label for a match, e.g. "S+W vs S+M"
export function matchLabel(m, tiers) {
  const t = (team) => team.map((id) => tiers[id].tier).sort().join("+");
  return `${t(m.teamA)} vs ${t(m.teamB)}`;
}

/* ---------------- combinatorics ---------------- */

const uid = () => Math.random().toString(36).slice(2, 9);
const pairKey = (a, b) => (a < b ? a + "|" + b : b + "|" + a);

function shuffle(arr) {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [a[i], a[j]] = [a[j], a[i]];
  }
  return a;
}

// All ways to split a list into unordered pairs (perfect matchings).
function matchings(list) {
  if (list.length === 0) return [[]];
  const [a, ...rest] = list;
  const out = [];
  for (let i = 0; i < rest.length; i++) {
    const tail = rest.slice(0, i).concat(rest.slice(i + 1));
    for (const m of matchings(tail)) out.push([[a, rest[i]], ...m]);
  }
  return out;
}

// All ways to group pairs into courts of two pairs each.
function courtings(pairs) {
  return matchings(pairs.map((_, i) => i)).map((groups) =>
    groups.map(([i, j]) => ({ teamA: pairs[i], teamB: pairs[j], scoreA: "", scoreB: "" }))
  );
}

function combos(list, k) {
  if (k === 0) return [[]];
  if (list.length < k) return [];
  const [a, ...rest] = list;
  return combos(rest, k - 1).map((c) => [a, ...c]).concat(combos(rest, k));
}

/* ---------------- session bookkeeping ---------------- */

export function counts(players, rounds) {
  const matches = {}, rests = {}, partner = {}, opponent = {};
  players.forEach((p) => { matches[p.id] = 0; rests[p.id] = 0; });
  rounds.forEach((r) => {
    r.matches.forEach((m) => {
      [...m.teamA, ...m.teamB].forEach((id) => { if (id in matches) matches[id]++; });
      const pa = pairKey(m.teamA[0], m.teamA[1]), pb = pairKey(m.teamB[0], m.teamB[1]);
      partner[pa] = (partner[pa] || 0) + 1;
      partner[pb] = (partner[pb] || 0) + 1;
      m.teamA.forEach((a) => m.teamB.forEach((b) => { const k = pairKey(a, b); opponent[k] = (opponent[k] || 0) + 1; }));
    });
    (r.resting || []).forEach((id) => { if (id in rests) rests[id]++; });
  });
  return { matches, rests, partner, opponent };
}

/* ---------------- scoring ---------------- */

const W_REPEAT = 1e7;   // R4
const W_ILLEGAL = 1e5;  // R1–R3
const W_EXT = 1e3;      // extension match-ups
const W_GAP = 10;       // (team rating gap)^2
const W_OPP = 40;       // facing the same opponent a 3rd+ time

function scoreRound(matches, ctx) {
  const { tiers, partner, opponent } = ctx;
  let repeats = 0, illegal = 0, ext = 0, soft = 0, maxGap = 0;
  matches.forEach((m, i) => {
    const others = matches.filter((_, j) => j !== i);
    const c = classifyMatch(m, others, tiers);
    if (c === 2) illegal++; else if (c === 1) ext++;
    repeats += partner[pairKey(m.teamA[0], m.teamA[1])] || 0;
    repeats += partner[pairKey(m.teamB[0], m.teamB[1])] || 0;
    const rA = m.teamA.reduce((s, id) => s + tiers[id].rating, 0);
    const rB = m.teamB.reduce((s, id) => s + tiers[id].rating, 0);
    soft += (rA - rB) * (rA - rB) * W_GAP;
    maxGap = Math.max(maxGap, Math.abs(rA - rB));
    m.teamA.forEach((a) => m.teamB.forEach((b) => {
      const n = opponent[pairKey(a, b)] || 0;
      if (n >= 2) soft += (n - 1) * W_OPP;
    }));
  });
  return { cost: repeats * W_REPEAT + illegal * W_ILLEGAL + ext * W_EXT + soft, repeats, illegal, ext, maxGap };
}

/* ---------------- candidate generation ---------------- */

const MAX_EXHAUSTIVE = 8; // on-court players; above this we sample instead of enumerating

function restingOptions(players, rounds, cnt, restCount) {
  if (restCount === 0) return [[]];
  const last = rounds.length ? new Set(rounds[rounds.length - 1].resting || []) : new Set();
  // fewest rests first; among ties, most games played; never twice in a row if avoidable
  const ids = players.map((p) => p.id).sort((a, b) =>
    cnt.rests[a] - cnt.rests[b] || cnt.matches[b] - cnt.matches[a]);
  const minRest = cnt.rests[ids[0]];
  let pool = ids.filter((id) => cnt.rests[id] === minRest && !last.has(id));
  if (pool.length < restCount) pool = ids.filter((id) => cnt.rests[id] === minRest);
  if (pool.length < restCount) pool = ids.slice(0, Math.max(restCount, Math.min(ids.length, restCount + 3)));
  return combos(pool, restCount);
}

export function candidateRounds(players, rounds, ctx) {
  const n = players.length;
  const restCount = n % 4;
  const cnt = counts(players, rounds);
  const out = [];
  for (const resting of restingOptions(players, rounds, cnt, restCount)) {
    const restSet = new Set(resting);
    const active = players.map((p) => p.id).filter((id) => !restSet.has(id));
    if (active.length < 4) { out.push({ resting, matches: [], ...scoreRound([], ctx) }); continue; }
    const seen = new Set();
    const consider = (pairs) => {
      for (const matches of courtings(pairs)) {
        const sig = matches.map((m) => pairKey(m.teamA.join(","), m.teamB.join(","))).sort().join(";");
        if (seen.has(sig)) continue;
        seen.add(sig);
        out.push({ resting, matches, ...scoreRound(matches, ctx) });
      }
    };
    if (active.length <= MAX_EXHAUSTIVE) {
      matchings(active).forEach(consider);
    } else {
      for (let t = 0; t < 1500; t++) {
        const s = shuffle(active);
        const pairs = [];
        for (let i = 0; i < s.length; i += 2) pairs.push([s[i], s[i + 1]]);
        consider(pairs);
      }
    }
  }
  return out;
}

/* ---------------- the generator ---------------- */

const LOOKAHEAD_TOP = 12;
const PLAN_BRANCH = 4;      // candidates tried per round in each planning restart
const PLAN_RESTART_MS = 250; // each randomised restart gets this long before we try a different ordering
const PLAN_JITTER = 300;     // randomisation of candidate order between restarts
const PLAN_FULL_BELOW = 30;  // when this few clean candidates remain, try them all
const W_SCARCE = 2000;       // planning: cost per Strong+Weak pair a round consumes
const PLAN_BUDGET_MS = 3000; // planning time cap when a fresh plan is needed (later rounds reuse it)
const DEFAULT_SESSION_ROUNDS = 8;
const GAP_CAP = 7.5;         // second planning pass refuses matches with a bigger team-rating gap

// Longest no-repeat session possible: every partnership used once.
export function maxNoRepeatRounds(n) {
  const courts = Math.floor(n / 4);
  return courts ? Math.floor((n * (n - 1)) / 2 / (2 * courts)) : 0;
}

// Clean candidates for the next round from a given state.
function cleanCandidates(players, soFar, tiers, gapCap) {
  const cnt = counts(players, soFar);
  return candidateRounds(players, soFar, { tiers, partner: cnt.partner, opponent: cnt.opponent })
    .filter((c) => c.repeats === 0 && c.illegal === 0 && c.matches.length && c.maxGap <= gapCap);
}

// Search for a run of rule-clean rounds (no repeats, no rule breaks) from the current
// state. Depth-first with randomised restarts inside the time budget.
// Returns the deepest plan found and whether it reached the horizon.
export function planAhead(players, rounds, tiers, horizon, budgetMs, gapCap = Infinity, tune = {}) {
  const deadline = Date.now() + budgetMs;
  const branch = tune.branch ?? PLAN_BRANCH, jitter = tune.jitter ?? PLAN_JITTER, fullBelow = tune.fullBelow ?? PLAN_FULL_BELOW;
  let bestPlan = [];
  const attempt = (restartDeadline) => {
    const dfs = (soFar, plan) => {
      if (plan.length >= horizon) return true;
      if (Date.now() > restartDeadline) return false;
      const cands = cleanCandidates(players, soFar, tiers, gapCap);
      if (!cands.length) return false;
      // Strong+Weak pairs are the scarce resource (every non Strong-v-Strong round burns 2–3 of
      // the 12), so rounds that spend fewer of them are explored first; then balance, then jitter.
      cands.forEach((c) => {
        const sw = c.matches.reduce((n, m) => n + (teamType(m.teamA, tiers) === "SW") + (teamType(m.teamB, tiers) === "SW"), 0);
        c.order = sw * W_SCARCE + c.cost + Math.random() * jitter;
      });
      cands.sort((a, b) => a.order - b.order);
      const pool = cands.length <= fullBelow ? cands : cands.slice(0, branch);
      for (const c of pool) {
        plan.push(c);
        if (plan.length > bestPlan.length) bestPlan = plan.slice();
        if (dfs(soFar.concat([{ id: "plan", matches: c.matches, resting: c.resting }]), plan)) return true;
        plan.pop();
        if (Date.now() > restartDeadline) return false;
      }
      return false;
    };
    return dfs(rounds, []);
  };
  while (Date.now() < deadline) {
    if (attempt(Math.min(deadline, Date.now() + (tune.restartMs ?? PLAN_RESTART_MS)))) return { plan: bestPlan, complete: true };
  }
  return { plan: bestPlan, complete: bestPlan.length >= horizon };
}

// players: [{id,name}]  rounds: previous rounds this session  hist: historyRatings(history)
// opts.fresh = true ignores the plan stored on the previous round (used by Reroll)
export function makeRound(players, rounds, hist, opts = {}) {
  const tiers = tiersFor(players, rounds, hist);
  const cnt = counts(players, rounds);
  const ctx = { tiers, partner: cnt.partner, opponent: cnt.opponent };
  const cands = candidateRounds(players, rounds, ctx);
  if (!cands.length) return { id: uid(), matches: [], resting: players.map((p) => p.id) };

  // 1. Reuse the plan stored on the previous round if it is still valid
  //    (same roster, nobody edited the rounds in between).
  const prev = rounds.length ? rounds[rounds.length - 1] : null;
  const stored = prev && prev.meta && Array.isArray(prev.meta.plan) ? prev.meta.plan : null;
  if (stored && stored.length && !opts.fresh) {
    const ids = new Set(players.map((p) => p.id));
    const c = stored[0];
    const everyone = [...c.resting, ...c.matches.flatMap((m) => [...m.teamA, ...m.teamB])];
    if (everyone.length === players.length && everyone.every((id) => ids.has(id))) {
      const sc = scoreRound(c.matches, ctx);
      if (sc.repeats === 0 && sc.illegal === 0) {
        return { id: uid(), matches: c.matches.map((m) => ({ ...m, scoreA: "", scoreB: "" })), resting: c.resting,
          meta: { repeats: 0, illegal: 0, ext: sc.ext, planned: stored.length, plan: stored.slice(1) } };
      }
    }
  }

  // 2. Plan ahead: look for a rule-clean path through the rest of the session,
  //    first insisting on close matches, then relaxing that if nothing fits.
  const onCourt = players.length - (players.length % 4);
  // Plan for a typical 8-round night (or fewer if the roster cannot go that long without repeats).
  const target = Math.min(opts.sessionRounds || DEFAULT_SESSION_ROUNDS, maxNoRepeatRounds(players.length));
  const horizon = target - rounds.length;
  if (onCourt <= MAX_EXHAUSTIVE && horizon > 1) {
    const budget = opts.budgetMs ?? PLAN_BUDGET_MS;
    // Rule-clean path first; if one exists, spend the rest of the budget looking for a closer-matched one.
    let best = planAhead(players, rounds, tiers, horizon, budget * 0.3);
    if (best.complete) {
      const tight = planAhead(players, rounds, tiers, horizon, budget * 0.7, GAP_CAP);
      if (tight.complete) best = tight;
    }
    if (best.plan.length) {
      const c = best.plan[0];
      // Carry the plan forward when it reaches the horizon, or falls one round short (then the
      // last round is genuinely impossible under the rules, e.g. 8 players over 7 rounds, and
      // the final round falls back to "fewest violations"). Shorter plans are re-planned next round.
      const rest = best.complete || best.plan.length >= horizon - 1
        ? best.plan.slice(1).map((x) => ({ matches: x.matches.map((m) => ({ teamA: m.teamA, teamB: m.teamB })), resting: x.resting }))
        : [];
      return { id: uid(), matches: c.matches, resting: c.resting,
        meta: { repeats: 0, illegal: 0, ext: c.ext, planned: best.plan.length, plan: rest } };
    }
  }

  // 2. Fallback: best round now, with a one-round lookahead (fewest violations first).
  const ranked = shuffle(cands).sort((a, b) => a.cost - b.cost);
  const top = ranked.slice(0, LOOKAHEAD_TOP);
  const bestHard = top[0].repeats * W_REPEAT + top[0].illegal * W_ILLEGAL;
  const pool = top.filter((c) => c.repeats * W_REPEAT + c.illegal * W_ILLEGAL === bestHard);

  let best = pool[0], bestTotal = Infinity;
  const doLookahead = onCourt <= MAX_EXHAUSTIVE && pool.length > 1;
  for (const c of pool) {
    let total = c.cost;
    if (doLookahead) {
      const future = rounds.concat([{ id: "tmp", matches: c.matches, resting: c.resting }]);
      const cnt2 = counts(players, future);
      const next = candidateRounds(players, future, { tiers, partner: cnt2.partner, opponent: cnt2.opponent });
      const nextBest = next.reduce((m, x) => Math.min(m, x.cost), Infinity);
      total += 0.5 * nextBest;
    }
    if (total < bestTotal) { bestTotal = total; best = c; }
  }

  return {
    id: uid(),
    matches: best.matches,
    resting: best.resting,
    meta: { repeats: best.repeats, illegal: best.illegal, ext: best.ext, planned: 0 },
  };
}
