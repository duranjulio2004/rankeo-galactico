# Rankeo Galáctico — Design

## 1. What it is

A place to rank anything with your friends. You create a **list** ("Completos
de Santiago", "Películas de Pixar", "Ramos de la carrera") and rank its items
by playing **duels**: two items appear, you pick the better one. After a few
dozen picks you get a full personal ranking with confidence bars. If the list
belongs to a **group**, the members' picks also build a **group ranking**, and
the app tells you who agrees with whom, which items are divisive, and what
your hot takes are.

Audience for v1: one friend group (tens of users, lists of 5–300 items). UI is
in Chilean Spanish; code and docs are in English.

## 2. Product decisions

| Decision | Choice | Why |
|---|---|---|
| Core interaction | 1v1 duels, keyboard + tap | Pairwise choices are fast and low-effort, and humans are much more consistent comparing two things than placing 50 on a scale. |
| Duel outcomes | Left / Right / **Empate** (tie) / **Paso** (skip) / **No lo conozco** (exclude item) | A forced choice between two things you can't judge poisons the data. Tie counts as half a win each. Skip records nothing. "No lo conozco" hides an item from *your* duels and *your* ranking (common in group lists: not everyone has seen every movie). |
| Undo | Undo last vote, any number of times | Misclicks happen at duel speed; without undo, people stop trusting their ranking. |
| Personal vs group | Every list is either private (owner only) or belongs to a group. Everyone who duels on a group list has a personal ranking of it; the group ranking aggregates members. | Both are first-class without two separate list types. A group list needs no extra setup: members just start dueling. |
| Who edits a group list | Any member can add items; creator can rename/archive items | Friend groups are high-trust; collecting items together is part of the fun. Archiving (not deleting) keeps past votes meaningful. |
| Tier lists | Auto-generated from the ranking (personal or group) by splitting the score scale at natural breaks | The tier list is a *view* of the ranking, not a second source of truth that can contradict it. Manual tier lists are listed under future work. |
| Group insights | Agreement matrix (Kendall τ between members), "alma gemela" / "polo opuesto", most divisive items, per-member hot takes | This is what makes a group ranking a social thing instead of an average. |
| Auth | Username + password, cookie sessions; groups joined via invite link | No email provider needed (would need a paid service/secrets); invite links are how friend groups actually share. |
| Who can sign up | Open by default; if `SIGNUP_CODE` is set, registering needs that code **or** any valid group invite code | A public URL shouldn't let strangers in, but "here's the invite link" must still be enough for a friend to join. |
| Visibility inside a group | Members can open each other's personal rankings of group lists | Comparing is the point ("¿en serio pusiste al Dinámico último?"). Private lists stay owner-only. |
| Leaving a group | Your votes stay in the DB but stop counting for the group | Group rankings reflect current members; rejoining restores your input. |

## 3. Ranking engine (the core)

All rankings are **computed on demand from raw votes**; nothing derived is
stored. Votes are the only source of truth, so undo, archiving an item, and
"no lo conozco" can never leave stale scores behind. Fitting 1–2k votes over a
few hundred items takes milliseconds, so caching is unnecessary at this scale
(see §7 for when it would be).

### 3.1 Model: Bradley–Terry with a prior
Each item *i* has a strength θᵢ; P(i beats j) = σ(θᵢ − θⱼ). This is the
standard model behind Elo, but fitted to **all** votes at once (maximum a
posteriori), so unlike Elo the result does not depend on vote order, and an
early lucky win doesn't stick forever.

- **Fit:** Hunter's MM algorithm (Hunter 2004): `γᵢ ← Wᵢ / Σⱼ nᵢⱼ/(γᵢ+γⱼ)`. It's simple,
  monotone, and needs no step size. Ties add ½ win to each side.
- **Prior:** each item plays one virtual win and one virtual loss against a
  fixed "average" item (γ = 1). This keeps undefeated/winless items finite and
  shrinks items with little evidence toward the middle, which is the right
  behaviour: one win shouldn't put a brand-new item at #1.
- **Uncertainty:** σᵢ² ≈ 1 / Iᵢ where Iᵢ = Σⱼ nᵢⱼ pᵢⱼ(1−pᵢⱼ) (+ the prior's
  contribution). That is the diagonal of the Fisher information. It's an
  approximation that ignores covariance, but it's good enough to drive pair
  selection and confidence bars.
- **Display rating:** `1500 + 400·θ/ln 10`, Elo-like, because people already
  read those numbers intuitively.
- **Weights:** every vote carries a weight (1 for personal rankings). Group
  aggregation uses weights (§3.4).

### 3.2 Confidence ("Qué tan seguro está tu rankeo")
For each adjacent pair in the ranking, P(order is right) ≈ Φ(Δθ / √(σᵢ²+σⱼ²)).
Ranking confidence = mean over adjacent pairs, rescaled from [0.5, 1] to
[0 %, 100 %]. Adjacent pairs are the hardest ones to get right, so this
is a conservative number that moves visibly as you vote. It's shown as a
progress bar on the duel screen, so it doubles as "how much more should I
play".

### 3.3 Choosing the next duel (active learning)
Random pairs waste most of the user's clicks on obvious matchups
(#1 vs #40). Each candidate pair (i, j) is scored:

```
info(i,j)  = p(1−p) · (σᵢ² + σⱼ²)          # expected information: close + uncertain
penalty    = 0.5^timesCompared(i,j)        # don't repeat the same duel
freshness  = items shown in the last 2 duels get ×0.15   # avoid "this one again?"
score      = info · penalty · freshness
```

The next pair is sampled from the top-scoring candidates with probability
∝ score (not argmax). Being a bit random avoids getting stuck on one pair and
keeps it feeling like a game. Left/right placement is randomized to cancel
position bias. Items with zero comparisons get a guaranteed early
appearance ("cold start"): until every item has been seen at least once, one
side of each duel is an unseen item. With n ≤ 300 items, scoring all n²/2
pairs per request is ~45k evaluations, which is negligible.

**Measured** (simulated voter with a hidden true order, 20 items, 20 seeds,
`test/ranking.test.ts`). τ is Kendall's correlation with the truth:

| voter | duels | active τ | random τ |
|---|---|---|---|
| consistent (Δθ = 1 per rank) | 40 | 0.77 | 0.68 |
| consistent | 60 | 0.87 | 0.76 |
| consistent | 100 | 0.93 | 0.84 |
| very noisy (Δθ = 0.3 per rank) | 100 | 0.78 | 0.76 |

For a consistent voter, 60 active duels beat 100 random ones (about 40% fewer clicks).
Prior strength (0.25–2 virtual games) changed τ by < 0.02. I kept 1 because
it better resists "one lucky win puts a new item at #1".

### 3.4 Group ranking
The group ranking is one Bradley–Terry fit over **all members' votes**, with
each member's votes weighted `wᵤ = min(1, M / nᵤ)` where *nᵤ* is that member's
vote count on the list and *M* is the median count among members who voted.

- Pooling votes (instead of averaging finished personal rankings) means every
  real comparison counts as evidence, and members who ranked only part of the
  list still contribute what they know.
- The cap stops one enthusiastic member with 500 votes from drowning out
  three friends with 40 each. Light voters are **not** amplified (w ≤ 1),
  because blowing up 5 noisy votes into the weight of 100 would be worse.
- Alternatives considered: averaging personal ranks (Borda) treats a member
  with 3 votes the same as one with 300; Schulze/Condorcet over personal
  rankings has the same problem and loses uncertainty information.

### 3.5 Group insights
- **Agreement** between two members = Kendall τ over the items both have
  ranked (each has ≥ 1 vote involving it and neither excluded it), shown as
  0–100 %. Computed only if they share ≥ 3 items.
- **Alma gemela / polo opuesto**: your highest/lowest agreement.
- **Divisive items**: standard deviation of each item's percentile rank across
  members' personal rankings.
- **Hot takes**: for each member, the items whose personal percentile differs
  most from the group percentile.

### 3.6 Tiers
Sort by θ, then partition the scores with **Jenks natural breaks** (optimal
1-D clustering by dynamic programming, O(k·n²)). The number of tiers is the
smallest k ≤ 6 whose goodness-of-variance-fit reaches 0.85. If the score
range is under 0.2 (e.g. no votes yet), everything is one tier. Tiers are
labelled S, A, B… in order.

I first planned "cut at the largest gaps", but it degenerates on noisy data:
it isolates single outliers and leaves one huge middle tier. Jenks minimizes
within-tier spread globally. Fixed percentiles were rejected because they put
two near-identical items in different tiers.

## 4. Architecture

```
browser (React SPA) ──fetch JSON──▶ Hono server (Node 24) ──▶ SQLite file
                                      │
                                      └─ ranking engine (pure TS, no I/O)
```

- **One process, one deployable.** The Node server serves the API under
  `/api` and the built SPA as static files. For a friend group this is the
  right size: one Railway service, one volume, no CORS.
- **Node 24 runs TypeScript directly** (built-in type stripping), so the server
  has no build step. Only the SPA is built (Vite).
- **SQLite via built-in `node:sqlite`.** Zero native dependencies (so no
  `node-gyp` failures in CI or in the container). The data is relational, and
  write volume is tiny. WAL mode, foreign keys on. Postgres would only add
  ops cost for one friend group.
- **Ranking engine is a pure module** (`src/server/ranking/`) with no DB access:
  input votes, output rankings. That's what makes it thoroughly testable.
- **Frontend:** React 19 + Vite, `wouter` for routing (1.5 kB), hand-written CSS
  with design tokens. No UI kit. The duel screen needs custom motion and
  keyboard handling anyway.

### 4.1 Data model

```
users(id, username UNIQUE, display_name, password_hash, created_at)
sessions(token_hash PK, user_id, expires_at)          -- token stored hashed
groups(id, name, emoji, invite_code UNIQUE, created_by, created_at)
group_members(group_id, user_id, joined_at)           PK(group_id, user_id)
lists(id, title, description, emoji, group_id NULL, owner_id, created_at)
items(id, list_id, name, emoji, image_url, created_by, archived, created_at)
votes(id, list_id, user_id, item_a, item_b, result, created_at)
     -- result: 1 = a wins, 0 = b wins, 0.5 = tie
exclusions(user_id, item_id)                          -- "no lo conozco"
```

Archived items are dropped from every ranking and from duel selection, but their votes are kept, so un-archiving restores
them.

### 4.2 Security
- Passwords: `scrypt` (node:crypto) with per-user salt, constant-time compare.
- Sessions: 32 random bytes in an `HttpOnly; SameSite=Lax` cookie (`Secure` in
  production); only the SHA-256 of the token is stored, so a DB leak doesn't
  leak live sessions. 30-day expiry.
- CSRF: SameSite=Lax + every mutating request must be `application/json`
  (forms can't send that cross-site without a CORS preflight, which we don't
  allow).
- Authorization: every list/group route checks membership server-side. A
  private list is visible only to its owner. Votes must reference two distinct,
  non-archived items of the same list.
- Login rate limit: in-memory per username+IP (fine for one process).
- Item images are external URLs rendered with `referrerpolicy=no-referrer`.
  Only `http(s)` URLs are accepted.

## 5. Milestones

- [x] **M0 Scaffold.** Repo, DESIGN, README, tooling, test runner.
- [x] **M1 Ranking engine.** BT fit, uncertainty, confidence, pair selection,
  group weighting, agreement/divisive/hot takes, tiers. Unit tests incl.
  recovery of a hidden true order from simulated noisy voters.
- [x] **M2 Backend.** Schema, auth, groups + invites, lists, items, votes,
  undo, exclusions, ranking endpoints. API tests against an in-memory DB.
- [ ] **M3 Frontend core.** Auth, home, create list (paste items), duel
  screen (keyboard, undo, tie/skip/exclude, confidence bar), personal ranking.
- [ ] **M4 Groups.** Group pages, invite links, group ranking, insights,
  tier view.
- [ ] **M5 Ship.** Dockerfile + Railway config, deploy instructions, polish.

## 6. Testing strategy
- Ranking engine: deterministic unit tests (seeded RNG), plus simulation
  tests. Simulated users with a hidden true order vote noisily, and the fitted
  ranking must correlate strongly with the truth. Active pair selection must
  beat random pairs on the same vote budget.
- API: `node:test` integration tests that boot the Hono app against an
  in-memory SQLite DB and exercise auth, authorization boundaries, voting,
  undo and group aggregation.
- Frontend: checked by hand in a browser (no automated UI tests in v1).

## 7. Known limits / future work
- Rankings are recomputed per request. If lists reach thousands of items or
  ~100k votes, cache fits per (list, user) and invalidate on vote.
- Diagonal-only uncertainty underestimates correlation; a full Laplace
  approximation would be better for very sparse data.
- Manual drag-and-drop tier lists (as a separate input that also feeds the
  model as weak pairwise evidence).
- Public share links for a read-only ranking/tier image.
- Single process + SQLite: no horizontal scaling. Fine for the target users.

## 8. Decision log
- 2026-10-06: Initial design (this document).
- 2026-10-06: Tiers switched from largest-gap cuts to Jenks natural breaks (§3.6).
- 2026-10-06: Dropped `concurrently` (critical advisory in its `shell-quote`
  dependency) for a 10-line `scripts/dev.mjs`.
