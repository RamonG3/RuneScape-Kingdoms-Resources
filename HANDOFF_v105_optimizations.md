# v105 + v106 — Performance pass (incoming changes)

**For the chat that owns `PROJECT_HANDOFF.md`.** A separate Claude Code session
is about to make the changes below, starting from the **v104** zips. Nothing
here changes game rules, data or UI. All of it is about download size, sync
traffic and caching. Fold the relevant parts into `PROJECT_HANDOFF.md` as each
deploy ships (the suggested edits are at the end), then delete this note.

**Revision 2** (still current for the plan; the status section above is revision 3) — it takes in your four review points:
- Two deploys instead of one.
- Board audio added tolerantly.
- The baseline correction.
- Audio caching on a miss, confirmed.

It also adds one new finding: **the board worker deletes the TTRPG's cache**
(§1). The handoff corrections from revision 1 are already in your updated
`PROJECT_HANDOFF.md`, so they are dropped from this note.

---

## Status — v105 built, not deployed (revision 3)

`patch_v105.py` has been applied to both v104 zips, producing
`rsk-site-v105-PUBLIC.zip` and `rsk-site-v105-PRIVATE.zip`.

- Public and private still differ only by `ttrpg/img/`.
- A second run of the script is refused.
- The script and `tests/t_v105.js` are on the repo branch. The **built sites
  are not**, because the GitHub repo is public.

| Check | Result |
|---|---|
| `tests/t_v105.js` (Playwright Chromium, real workers) | **54/54** public (run twice), **54/54** private |
| `t_necromancy.js`, v105 against v104 | 146/146, same as v104 |
| `t_homebrewrules.js`, v105 against v104 | 137/139, with **the same two** wrong-baseline failures as v104 against v104 (no v102 build in this session) |

What `t_v105.js` proves:
- All 16 clips are byte-identical to v104's inline data.
- The rest of the board page is byte-identical.
- The TTRPG page differs by the pin line only.
- `ASSETS` is still 33 entries, every one of which exists.
- The TTRPG cache survives the board worker activating, **and the same
  scenario on v104 wipes it (control)**. Old `rsk-sheet-v8.17` is still
  cleaned up, and a foreign `rsk-audio-v1` is left alone.
- All 16 sounds play through `RSK_BOARD.playSound`, online and offline.
- With `melee.mp3` missing, the worker still installs, and the clip caches
  on its first play and then plays offline. Control: the same missing file
  inside the atomic list leaves no worker.
- The page requests exactly `@2.116.0`, the real 2.116.0 build loads, and the
  page errors and UI match v104 given the same library.

**The Supabase pin is 2.116.0, not "whatever @2 serves".** npm shows 2.117.0
was published on 2026-09-22 at 12:57 UTC, the same day as this build. 2.116.0
(2026-09-07) is what `@2` served for the two weeks before, so it is what the
table has actually run.

**Still open before the board half ships:**
- `which-build.py`, `t_board.js`, `t_boardsw.js` and `t_boardicons.js` have not
  been run: none were provided to this session. `board/audio/` is a new folder
  in both builds; see whether `which-build.py` needs it whitelisted.
- Board sounds need a check on an iPhone, online and in airplane mode. Only
  Chromium was tested.
- Pre-v8 cache names: keeping the strict `rsk-sheet-` prefix, as you advised.
  Add any remembered older name to the delete list explicitly.

**Deploy gate for v106 (your scheduling point):** let v105 sit for a session or
two. Confirm the board is on `rsk-sheet-v8.18` on the devices that matter:
DevTools → Application → Cache storage shows `rsk-sheet-v8.18`; on a phone,
open the board once online and reload it. **Only then ship v106.** Until every
device has switched, an old board worker keeps deleting every cache but its
own, including v106's `rsk-audio-v1`, and the audio fix will look broken.

**Test-writing traps found along the way**, worth adding to §5 of your
handoff:
- The board page registers its worker only on `https:` or a hostname of
  exactly `localhost`. On `127.0.0.1` no worker ever installs, and every
  worker test quietly passes or fails for the wrong reason.
- Playwright's `context.route` does not see requests made **by a service
  worker**, so a test that stubs a CDN must block workers or serve the stub
  some other way.
- The TTRPG page reloads itself on its first `controllerchange`, so any probe
  running on that page must tolerate a navigation mid-evaluate.

---

## 0. Two deploys, two patch scripts

| | v105 — low risk | v106 — the risky half |
|---|---|---|
| Script | `patch_v105.py` | `patch_v106.py` (needs v105) |
| Contents | Supabase pin · board sounds to files · board cache-cleanup fix | TTRPG worker rewrite · GM roster sync (block 24) |
| ttrpg `CACHE_VERSION` | `rsk-v3-2026-09-22.96-pin` | `rsk-v3-2026-09-22.97-sync` |
| board worker | `rsk-sheet-v8.18` | unchanged |
| Rollback | redeploy v104 | redeploy v105 |

Both scripts work like `patch_v104.py`:
- every anchor is asserted to match exactly once before anything is written;
- the backtick count is asserted unchanged;
- the script aborts rather than guessing.

If you ship something first, the scripts re-apply on top of your build and
renumber. **v106 depends on v105's board fix** (§1) and refuses to apply
without it. If either version name is already taken, say so and the pass will
take the next number.

### Coordination: what to avoid until each deploy is merged

| File / area | Changed in | Please avoid meanwhile |
|---|---|---|
| `board/index.html`: the `SOUNDS` object | v105 (in place) | editing it |
| `board/sw.js` | v105 | any edit, including a bump |
| `board/audio/` | v105, **new folder** | none |
| `ttrpg/index.html`: the `supabase-js@2` `<script>` tag | v105 (URL only) | none |
| `ttrpg/sw.js` | v105 (version bump only), v106 (**rewritten**) | any edit, including a bump |
| `ttrpg/index.html`: before `</body>` | v106 appends **block 24** | appending your own block 24 without renumbering |

Everything else is untouched. **Necromancy phase 2 can go ahead in parallel**,
as long as it only appends blocks and edits data.

---

# v105 — low risk

## 1. Board worker: stop deleting the TTRPG's cache (new finding)

Both apps are served from **one origin**, and CacheStorage is per origin, not
per worker scope. The board worker's activate step deletes **every cache that
isn't its own**:

```js
keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))
```

So the first time anyone opens the board after a board deploy, the TTRPG's
`rsk-cache-*` cache is wiped. That cache holds the TTRPG shell and all 2.96 MB
of audio, so TTRPG offline breaks until the TTRPG app is next opened online,
and then the audio downloads again.

**Reproduced on unmodified v104** in Playwright Chromium, serving `pub/`:

```
after opening /ttrpg/ : [ 'rsk-cache-rsk-v3-2026-09-22.95-necromancy' ]
after opening /board/ : [ 'rsk-sheet-v8.17' ]
```

The TTRPG worker has always been polite (it only deletes `rsk-cache-*`); the
board worker was not.

**Fix:** the filter becomes `k.startsWith('rsk-sheet-') && k !== CACHE`.

- Every board cache is named `rsk-sheet-v8.N`, so each earlier board version
  is still cleaned up.
- **Please check whether anything older than v8 used a name not starting
  `rsk-sheet-`.** If so, those caches will linger. That wastes disk space but
  breaks nothing, and the pattern can be widened if needed.
- The fix only takes effect once v105's board worker is the one activating.
  Until every device has picked up v105, an old board worker can still wipe a
  TTRPG cache once.

## 2. Board: the 16 inline sounds become files

**Why.** `board/index.html` is 829 KB, and 703 KB of that is 16 base64 MP3s in
`SOUNDS`. Without them the page is 126 KB (about 37 KB compressed, down from
about 518 KB). The page is network-first, so every board deploy made every
device download all the sound again.

**What changes.**
- The clips are decoded unchanged to `board/audio/<id>.mp3`. The ids are:
  prayer, summoning, runecrafting, quest, coins, death, ohdear, damage, melee,
  ranged, magic, defence, thieving, gathering, crafting, cooking.
- `SOUNDS` keeps its keys. Each value becomes `"audio/<id>.mp3"`.
- `playSound` is untouched, and so is the `RSK_BOARD` seam.

**Worker: the clips are NOT added to the atomic `ASSETS` list** (your point 2).
- `ASSETS` stays at **33 entries**, still installed with atomic
  `cache.addAll`, so `t_boardicons` / `t_boardsw` are unaffected.
- A separate `AUDIO` list is added **tolerantly** after it, one
  `cache.add(url).catch(warn)` per clip, as the TTRPG worker does. A missing
  MP3 costs that one sound offline, never the install.
- **On a miss, audio still caches.** `.mp3` is not app code, so it goes
  through the worker's existing `cacheFirst`, which already stores any
  same-origin response with `res.ok`. A clip that failed at install, or one
  added later without being listed, caches on its first play.

**Consequences.**
- `which-build.py`: `board/audio/` is a new folder in **both** builds. **If the
  script flags unknown folders, it needs whitelisting.**
- Risk to check: Safari/iOS playing audio served by a service worker (range
  requests). The TTRPG app already plays its clips this way, but v105 will
  still be checked on an iPhone, online and offline.

## 3. TTRPG: pin supabase-js

`…/supabase-js@2` means "latest 2.x". An upstream release reaches players
without a deploy.
- v105 pins the **exact version jsDelivr currently serves for `@2`**, keeping
  the same file path, so the code players run doesn't change. The version will
  be read from the live site at implementation time, because the CDN is not
  reachable from the sandbox.
- This is one anchored in-place edit. The harnesses match the CDN with
  `/supabase-js/` and are unaffected.
- `ttrpg/sw.js` changes by its version bump only.

**New rule:** upgrading Supabase becomes a deliberate edit of that URL, plus a
`CACHE_VERSION` bump.

---

# v106 — the risky half

## 4. TTRPG: `ttrpg/sw.js` rewritten

**Why.** Two problems:
- The 46 audio clips (2.96 MB) share the cache that is renamed on every build,
  so every deploy made every device download all the audio again.
- The page is cache-first, so the first open after a deploy shows the old
  build and then force-reloads. This is the same fault the board fixed at
  v100.

**New behaviour (the board's v100 strategy, ported):**

| Request | Strategy | Cache |
|---|---|---|
| navigations, `*.html`, `*.js`, `*.json`, manifest (same origin) | **network-first**; navigations fall back to cache after 4 s; 404/500 fall back to the cached copy | `rsk-cache-<CACHE_VERSION>` |
| `audio/*` | cache-first, **stored on a miss** | **`rsk-audio-v1`**: *not* renamed per build |
| icons, `sheet-blank.pdf`, `art/`, `img/*.png`, Google Fonts | cache-first | `rsk-cache-<CACHE_VERSION>` |
| exact-version jsDelivr URLs (`pdf-lib@1.17.1`, the pinned supabase-js) | cache-first (immutable URLs) | `rsk-cache-<CACHE_VERSION>` |
| Supabase API | untouched, network only | none |

**How the audio cache is filled (your point 4).** Two independent paths:

1. **Install** walks the known clip list and adds only the clips missing from
   `rsk-audio-v1`, tolerantly. A version bump therefore downloads **no** audio.
2. **Fetch** handles every `audio/*` request: it looks in the cache, and on a
   miss fetches and **stores the response in `rsk-audio-v1`** whenever
   `res.ok` is true.

So a `necromancy.ogg` dropped in later caches offline on its first play, with
no change to the worker. Adding it to the list only precaches it before first
use. `t_ttrpgsw.js` tests this directly: it serves an unlisted clip, fetches
it once, goes offline and fetches it again. There is also a mutation control:
removing the put-on-miss must turn that test red.

**Rules that change:**
- **Replacing an audio clip** needs a new file name *or* a bump to
  `AUDIO_CACHE`. Bumping `CACHE_VERSION` alone no longer refreshes audio.
- The audio cache name must **never start with `rsk-cache-`** (the TTRPG
  worker deletes every `rsk-cache-*` except the current one), and must never
  start with `rsk-sheet-` (the board's cleanup pattern after v105).
- `sheet-blank.pdf` stays cache-first in the versioned cache, so "bump
  `CACHE_VERSION` when swapping it" still holds.
- `img/index.json`, `bestiary.js` and `bestiary-homebrew.js` become
  network-first. `index.json` was accidentally cache-first before, which
  overrode the page's own `cache:'no-cache'` fetch.
- The install stays tolerant of missing files. The registration code in
  `index.html` is **not edited**.

## 5. TTRPG: GM roster traffic (new block 24, `GM ROSTER SYNC`)

**Why.** Each player's heartbeat upserts their **whole sheet** every 9 s. On
the GM's device, every `players` change refetches **every** sheet
(`players_by_code`) and redraws the roster and combat panels. That's about
33 full-party fetches a minute with 5 idle players. There is also no in-flight
guard, so an older response can overwrite a newer party.

**One appended block, nothing edited in place:**

1. **Heartbeat-only events skip the fetch.** The block wraps
   `sb.channel(...).on(...)` for the `players` subscription only, and **wraps**
   the original callback rather than replacing it.
   - When the realtime payload's `new.sheet` matches the GM's cached copy
     (ignoring `seen`), it only updates `party[id].seen` and calls
     `renderRoster()`, so the online dot stays right. No request is sent.
   - In every other case the original callback runs unchanged. That includes
     a missing or truncated payload, an unknown player, a DELETE, or a real
     change.
2. **Roster fetches are serialized.** `window.sList` is wrapped for `rsk-pc:`
   only. Calls that arrive during an in-flight fetch share **one** trailing
   fetch, so there is never more than one in flight and responses can't land
   out of order.

**Unchanged:**
- The player side (heartbeat interval, the 20 s online threshold).
- The schema, RLS and RPCs.
- The co-GM block.
- Old player clients.

**Must be verified live on `rsktest` before trusting it:** that the GM's
realtime payload actually carries `new.sheet`. The check is the network tab on
the GM's device, with two players idle for a minute; expect about 0
`players_by_code` calls. If it doesn't carry `new.sheet`, part 1 is simply
inert and part 2 still applies.

**Wrapper table additions:**

| Function | Wrapped by | Guard |
|---|---|---|
| `window.sList` | co-GM devices · **GM roster sync** | `__rskCoGm` (block-level) · **`_rskRosterSync`**, which copies every flag of the function it wraps |
| `sb.channel` (the client method) | **GM roster sync** | **`_rskRosterSync`** |

**Deferred:** moving "online" to Realtime **Presence** and stopping heartbeat
DB writes. It needs every client updated and a fallback for old ones.

---

## 6. Tests

**Baseline correction (your point 3).** `t_homebrewrules.js` is **139/139** on
v104 when run with the right v102 baseline, as you found. The 137/139 this
session reported came from passing a later build as the second argument. It
was never a code failure. Also note:
- The harnesses need **`jsdom@24`**. jsdom 27 removed `ResourceLoader`, and
  both crash on load with it.
- `t_necromancy.js`: 146/146 on v104.

**v105:**
- Re-run `t_necromancy.js` and `t_homebrewrules.js` (the Supabase pin must not
  change either score).
- In Playwright Chromium:
  - every board sound plays online and offline;
  - a missing MP3 does **not** fail the board install;
  - opening the board no longer deletes `rsk-cache-*`, with a mutation
    control that restores the old filter and must turn it red.
- iPhone check of board sounds.
- Please run `t_board.js`, `t_boardsw.js`, `t_boardicons.js` and
  `which-build.py` if you have them.

**v106:**
- **New `t_ttrpgsw.js`** (Playwright, `t_boardsw.js` style):
  - the first load after a deploy is the new build;
  - a version bump downloads **no** audio;
  - an unlisted clip caches on its first fetch and plays offline;
  - audio survives both workers' cleanup;
  - offline, a slow network and server errors behave correctly.
- **New `t_gmsync.js`** (jsdom; the fake channel **captures** callbacks):
  - a heartbeat-only event makes 0 RPCs and still refreshes the online dot;
  - a real change refetches;
  - a missing payload falls back to the original path;
  - N overlapping events make at most 2 RPCs;
  - a slow older response never wins.
  - Mutation controls on the payload check and on the serializer.
- Re-run the v105 set, plus the 18 older TTRPG harnesses if you have them.

---

## 7. Suggested edits to `PROJECT_HANDOFF.md`

**When v105 ships:**
- Header: ttrpg `…96-pin`, board `rsk-sheet-v8.18`.
- §2 tree: add `board/audio/` (16 mp3). Change `board/index.html` to about
  126 KB and drop "~700 KB of it inline sound".
- §6:
  - `board/audio/` is tolerant, outside `ASSETS`, and caches on a miss;
  - the board worker only deletes `rsk-sheet-*` caches;
  - the Supabase pin rule.
- §7 Working principles: **"Workers on one origin share CacheStorage.
  A worker's cleanup must only delete caches carrying its own prefix."**

**When v106 ships:**
- Header: ttrpg `…97-sync`.
- §2: block 24 `GM ROSTER SYNC`, and the two wrapper-table rows.
- §3: heartbeat-only changes no longer refetch the party on the GM's device.
- §5: add `t_gmsync.js` and `t_ttrpgsw.js`, and the `jsdom@24` requirement.
- §6: the TTRPG worker strategy table and the audio-cache rules.
- §9 Infrastructure: Presence instead of heartbeat writes, as the deferred
  follow-up.
