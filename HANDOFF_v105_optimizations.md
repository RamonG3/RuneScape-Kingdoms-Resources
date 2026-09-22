# v105 — Performance pass (incoming changes)

**For the chat that owns `PROJECT_HANDOFF.md`.** A separate Claude Code session
is about to make the changes below, starting from the **v104** zips. This note
tells you what it will touch so you can plan around it. Nothing here changes
game rules, data or UI. All of it is about download size, sync traffic and
caching.

Once v105 lands, fold the relevant parts into `PROJECT_HANDOFF.md` (the
suggested edits are at the end) and delete this note.

---

## 0. Coordination: what to avoid until v105 is merged

| File / area | v105 touches it | Please avoid meanwhile |
|---|---|---|
| `board/index.html`: the `SOUNDS` object and `playSound` | yes, in place | editing either |
| `board/sw.js` | yes (`ASSETS` + version bump) | bumping it yourself |
| `board/audio/` | **new folder** | none |
| `ttrpg/sw.js` | **rewritten** (small file) | any edit, including a version bump |
| `ttrpg/index.html`: the `supabase-js@2` `<script>` tag | yes, in place (the URL only) | none |
| `ttrpg/index.html`: before `</body>` | **new block 24** appended | appending your own block 24 without renumbering |

Everything else in `ttrpg/index.html` is untouched. **Necromancy phase 2 can go
ahead in parallel**, as long as it only appends blocks and edits data.

**How it will be delivered:** as `patch_v105.py`, in the same style as
`patch_v104.py`. Every anchor is asserted to match exactly once before
anything is written, the backtick count is asserted unchanged, and it aborts
otherwise. If you ship something first, the script re-applies on top of your
build and that build becomes v106. If an anchor has moved, it aborts instead
of guessing.

Version names this pass will use:
- ttrpg `CACHE_VERSION`: `rsk-v3-2026-09-22.96-perf`
- board: `rsk-sheet-v8.18`

If you have already minted either of these, say so and v105 will take the next
number.

---

## 1. Board: the 16 inline sounds become files

**Why.** `board/index.html` is 829 KB, and 703 KB of that is 16 base64 MP3s in
the `SOUNDS` object. Without them the page is 126 KB (about 37 KB compressed,
down from about 518 KB). The board SW serves the page **network-first**, so
until now every board deploy made every device download all the sound again.

**What changes.**
- The 16 clips are decoded unchanged to `board/audio/<id>.mp3`. The ids are:
  prayer, summoning, runecrafting, quest, coins, death, ohdear, damage, melee,
  ranged, magic, defence, thieving, gathering, crafting, cooking.
- `SOUNDS` keeps its shape and keys. Each value becomes `"audio/<id>.mp3"`
  instead of a data URI. `playSound` is untouched: `new Audio(path)` behaves
  the same, and the `!SOUNDS[id]` guard still works.
- **The `RSK_BOARD` seam is unchanged.** `playSound` is still exported and the
  quest menu still calls `API.playSound(...)`.
- `board/sw.js`: the 16 files are added to `ASSETS`, and the version goes to
  `rsk-sheet-v8.18`. `.mp3` is not app code under `isAppCode`, so the clips are
  served **cache-first**: downloaded once and kept offline.

**Consequences to account for.**
- `ASSETS` goes from 33 to 49 entries, and `cache.addAll` is still atomic, so
  **`board/audio/` must be in every deploy** or the board SW install fails.
  `t_boardicons.js` / `t_boardsw.js` check every `ASSETS` entry exists, so they
  will require these files.
- `which-build.py`: `board/audio/` is a new folder in **both** builds.
  **If the script flags unknown folders, it needs whitelisting.**
- The one known risk is Safari/iOS playing audio served by a service worker
  (range requests). The TTRPG app already plays its clips this way, but v105
  will still be checked on an iPhone, online and offline, before it ships.

---

## 2. TTRPG: GM roster traffic (new block 24, `GM ROSTER SYNC`)

**Why.** Each player's `startHeartbeat` upserts their **whole sheet** every 9 s
to update `seen`. On the GM's device, every `players` change runs the
`startPolling` handler. That handler calls `sList` (one `players_by_code` RPC
returning **every** sheet), then `renderRoster()` + `refreshCombatLive()`.

With 5 idle players that's about 33 full-party fetches a minute. The handler
also has no in-flight guard, so two overlapping fetches can resolve out of
order and an older party can overwrite a newer one.

**What changes. One appended block, nothing edited in place:**

1. **Heartbeat-only events skip the fetch.** The block wraps
   `sb.channel(...).on(...)` for the `players` subscription only, and
   **wraps** the original callback rather than replacing it. When the realtime
   payload's `new.sheet` matches the GM's cached copy of that player
   (ignoring `seen`), it only updates `party[id].seen` and calls
   `renderRoster()` so the online dot stays correct. It sends no request.
   In every other case the original callback runs exactly as it does today.
   That includes a missing or truncated payload, an unknown player, a DELETE,
   or any real sheet change.
2. **Roster fetches are serialized.** `window.sList` is wrapped for
   `rsk-pc:` prefixes only. While a `players_by_code` fetch is in flight, any
   calls that arrive share **one** trailing fetch made after it finishes. At
   most one fetch is in flight at a time, responses cannot land out of order,
   and a burst of combat actions becomes at most two fetches. Other prefixes
   pass straight through.

**What does not change:**
- The player side: the heartbeat still runs every 9 s, and the 20 s online
  threshold in `renderRoster` stays.
- The schema, RLS and RPCs.
- The co-GM block.
- Old player clients work unchanged, because only the GM's device behaves
  differently.

Co-GM devices keep today's behaviour whenever realtime gives them no usable
payload.

**Wrapper table additions (§2 of the handoff):**

| Function | Wrapped by | Guard |
|---|---|---|
| `window.sList` | co-GM devices · **GM roster sync** | `__rskCoGm` (block-level) · **`_rskRosterSync`**, which copies every flag of the function it wraps |
| `sb.channel` (the client method) | **GM roster sync** | **`_rskRosterSync`** |

If you wrap `sList` later, carry `_rskRosterSync` forward.

**Deliberately not done (needs a decision later):** moving "online" to Supabase
Realtime **Presence** and stopping the heartbeat's DB writes. That would also
cut the players' upload traffic, but it needs every client updated and a
fallback for old ones, so it is out of scope for v105.

---

## 3. TTRPG: `ttrpg/sw.js` rewritten

**Why.** Two problems:
- All 46 audio clips (2.96 MB) live in the same cache as the shell, which is
  renamed on every build, so every deploy made every device download all the
  audio again.
- The page itself is cache-first, so the first open after a deploy shows the
  old build and then force-reloads. This is the same fault the board fixed
  at v100.

**New behaviour (the board's v100 strategy, ported):**

| Request | Strategy | Cache |
|---|---|---|
| navigations, `*.html`, `*.js`, `*.json`, manifest (same origin) | **network-first**; navigations fall back to cache after 4 s; 404/500 fall back to the cached copy | `rsk-cache-<CACHE_VERSION>` |
| `audio/*` | cache-first | **`rsk-audio-v1`**: *not* renamed per build; install adds only clips that are missing |
| icons, `sheet-blank.pdf`, `art/`, `img/*.png`, Google Fonts | cache-first | `rsk-cache-<CACHE_VERSION>` |
| exact-version jsDelivr URLs (`pdf-lib@1.17.1`, pinned supabase-js) | cache-first (immutable URLs) | `rsk-cache-<CACHE_VERSION>` |
| Supabase API | untouched, network only | none |

**Rules that change. Please carry these into the handoff:**
- **Replacing an audio clip** now needs a new file name *or* a bump to
  `AUDIO_CACHE` in `sw.js`. Bumping `CACHE_VERSION` alone no longer refreshes
  audio.
- The audio cache name must **never start with `rsk-cache-`**, because
  activate deletes every `rsk-cache-*` except the current one.
- `sheet-blank.pdf` stays cache-first in the versioned cache, so "bump
  `CACHE_VERSION` when swapping it" still holds.
- `img/index.json` becomes network-first (it is `.json`). It was
  accidentally cache-first before, which silently overrode the page's own
  `cache:'no-cache'` fetch.
- `bestiary.js` / `bestiary-homebrew.js` become network-first too. The
  install stays tolerant of missing files, as today.
- The registration code in `index.html` (toast + `skipWaiting` +
  one reload on `controllerchange`) is **not edited**.
- "Bump `CACHE_VERSION` every single build" still applies.
- A future `necromancy.ogg` is picked up by the audio route automatically.
  Adding it to the SW's `SKILLS` list is only needed to precache it.

---

## 4. TTRPG: pin supabase-js

`<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2">` means
"latest 2.x". An upstream release reaches players without a deploy, and the
URL can't be cached safely. v105 pins the **exact version jsDelivr currently
serves for `@2`**, keeping the same file path, so the code players run doesn't
change.

This is one anchored in-place edit of the URL. Both harnesses match the CDN
with `/supabase-js/`, so they are unaffected.

**New rule:** upgrading Supabase becomes a deliberate edit of that URL, plus a
`CACHE_VERSION` bump.

---

## 5. Tests

- `t_necromancy.js` and `t_homebrewrules.js` need **`jsdom@24`**. jsdom 27
  removed `ResourceLoader`, and the harnesses crash on load with it.
  Baseline on untouched v104: **146/146** and **137/139**. The 2 failures only
  happen when v104 stands in for the v102 baseline, and are expected.
- **New `t_gmsync.js`** (jsdom, same fake-Supabase pattern, but the fake
  channel **captures** the callbacks so events can be fired):
  - a heartbeat-only event makes 0 RPCs and still refreshes the online dot;
  - a real sheet change refetches;
  - a missing payload falls back to the original path;
  - N overlapping events make at most 2 RPCs;
  - a slow older response never overwrites a newer party;
  - mutation controls: removing the payload check, and removing the
    serializer, each turn a test red.
- **New `t_ttrpgsw.js`**, in the style of `t_boardsw.js`:
  - first load after a deploy is the new build;
  - a version bump downloads **no** audio;
  - offline, a slow network and server errors behave as on the board;
  - audio survives activate's cleanup.
- Both harnesses above are re-run against v105 and must stay at their
  baseline.
- **Board sounds:** checked in Playwright Chromium (every id plays online and
  offline) and on a real iPhone.
- **Please run** `t_board.js`, `t_boardsw.js`, `t_boardicons.js`,
  `which-build.py` and the 18 older TTRPG harnesses against v105 if that chat
  has them. None were provided to this session.

---

## 6. Handoff corrections found along the way

- §2 says `ttrpg/index.html` is **494 KB**. It is **700 KB** at v104
  (about 200 KB compressed).
- §6 says a missing `bestiary-homebrew.js` "breaks offline for the whole app"
  because `cache.addAll` is atomic. That is **not true of the TTRPG worker**,
  which adds files one by one and tolerates misses. Only the **board** worker
  uses atomic `addAll`. v105 keeps both behaviours as they are.
- Measured, so nobody chases it: the 32 MutationObservers in the appended
  blocks cost about **3 ms in total over 20 rolls**. The append-and-wrap
  design is not a runtime performance problem.

## 7. Suggested edits to `PROJECT_HANDOFF.md` once v105 ships

- Header: current build v105, ttrpg `…96-perf`, board `rsk-sheet-v8.18`.
- §2 table: add block 24 `GM ROSTER SYNC`, and the two wrapper-table rows
  from §2 above.
- §2 architecture tree: add `board/audio/` (16 mp3). Change the
  `board/index.html` size to about 126 KB and drop "~700 KB of it inline
  sound".
- §3: note that heartbeat-only changes no longer refetch the party on the
  GM's device.
- §5: add `t_gmsync.js` and `t_ttrpgsw.js`, and the `jsdom@24` requirement.
- §6: the new audio-cache rule, the Supabase pin rule, `board/audio/` in
  every deploy, and the corrected note about which worker is atomic.
- §9 Infrastructure: "Presence instead of heartbeat writes" as the deferred
  follow-up.
