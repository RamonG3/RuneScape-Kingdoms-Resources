#!/usr/bin/env python3
"""v105 — low-risk half of the performance pass. Applies on top of v104
(or any later build whose anchors still match). Every anchor is asserted to
match exactly once BEFORE anything is written; on any mismatch it aborts and
the folder is left untouched.

  python3 patch_v105.py <site folder>        (run once per build: pub, priv)

  1. board/sw.js    — activate only deletes rsk-sheet-* caches. It used to
                      delete EVERY other cache on the origin, which wiped the
                      TTRPG's offline cache each time a board worker activated.
  2. board          — the 16 inline base64 MP3s in SOUNDS become
                      board/audio/<id>.mp3. They are added to the worker
                      TOLERANTLY, outside the atomic ASSETS list, and the
                      worker's cacheFirst already stores them on a miss.
  3. ttrpg          — supabase-js pinned from @2 (floating) to an exact version.
"""
import sys, re, base64, pathlib

SUPABASE_PIN = '2.116.0'     # what @2 served from 2026-09-07 until 2.117.0 on 09-22
TTRPG_CV = 'rsk-v3-2026-09-22.96-pin'
BOARD_CV_OLD = 'rsk-sheet-v8.17'
BOARD_CV_NEW = 'rsk-sheet-v8.18'
SOUND_IDS = ['prayer', 'summoning', 'runecrafting', 'quest', 'coins', 'death', 'ohdear', 'damage',
             'melee', 'ranged', 'magic', 'defence', 'thieving', 'gathering', 'crafting', 'cooking']

site = pathlib.Path(sys.argv[1])
b_idx = site / 'board' / 'index.html'; b_sw = site / 'board' / 'sw.js'
t_idx = site / 'ttrpg' / 'index.html'; t_sw = site / 'ttrpg' / 'sw.js'
bi = b_idx.read_text(encoding='utf-8'); bw = b_sw.read_text(encoding='utf-8')
ti = t_idx.read_text(encoding='utf-8'); tw = t_sw.read_text(encoding='utf-8')
BT_B, BT_T = bi.count('`'), ti.count('`')

def one(text, old, what):
    n = text.count(old)
    if n != 1: sys.exit('ABORT (%s): anchor matched %d times:\n%s' % (what, n, old[:200]))

# ── refuse a second run ──────────────────────────────────────────────────
if (site / 'board' / 'audio').exists() or 'k.startsWith("rsk-sheet-")' in bw or BOARD_CV_NEW in bw:
    sys.exit('ABORT: already patched')

# ── 1+2. board worker ────────────────────────────────────────────────────
one(bw, 'const CACHE = "%s";' % BOARD_CV_OLD, 'board version')
OLD_ACT = '.then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))'
NEW_ACT = ('.then((keys) => Promise.all(keys.filter((k) => k.startsWith("rsk-sheet-") && k !== CACHE)'
           '.map((k) => caches.delete(k))))')
one(bw, OLD_ACT, 'board activate filter')
OLD_INST = 'caches.open(CACHE).then((c) => c.addAll(ASSETS)).then(() => self.skipWaiting())'
NEW_INST = ('caches.open(CACHE)\n'
            '      .then((c) => c.addAll(ASSETS).then(() => Promise.all(AUDIO.map((u) =>\n'
            '        c.add(u).catch(() => console.warn("[sw] could not cache", u))))))\n'
            '      .then(() => self.skipWaiting())')
one(bw, OLD_INST, 'board install')
OLD_HEAD = '   - cache.addAll is atomic: every file in ASSETS must exist in the deploy,\n     or the install fails and devices stay on the old worker. */'
NEW_HEAD = ('   - cache.addAll is atomic: every file in ASSETS must exist in the deploy,\n'
            '     or the install fails and devices stay on the old worker.\n'
            '   - (v105) The level-up sounds are files in audio/, cached TOLERANTLY after\n'
            '     ASSETS, one by one: a missing clip costs that sound offline, never the\n'
            '     install. cacheFirst stores any same-origin miss, so a clip that failed\n'
            '     here, or a new one never listed, still caches on its first play.\n'
            '   - (v105) Both apps share this ORIGIN, and so one CacheStorage. activate\n'
            '     deletes only rsk-sheet-* caches: it used to delete every cache but its\n'
            '     own, which wiped the TTRPG app\'s offline cache on each board update. */')
one(bw, OLD_HEAD, 'board header comment')
OLD_ASSETS_END = '  "./apple-touch-icon.png"\n];\n'
one(bw, OLD_ASSETS_END, 'board ASSETS end')
NEW_ASSETS_END = (OLD_ASSETS_END +
    '/* not in ASSETS on purpose: added tolerantly at install, see above */\n'
    'const AUDIO = [' + ', '.join('"audio/%s.mp3"' % i for i in SOUND_IDS).replace('"audio', '"./audio') + '];\n')

# ── 2. board page: extract SOUNDS ────────────────────────────────────────
m = re.search(r'const SOUNDS=\{(.*?)\};\n', bi, re.S)
if not m or bi.count('const SOUNDS={') != 1: sys.exit('ABORT: SOUNDS object not found exactly once')
pairs = re.findall(r'(\w+):"data:audio/mpeg;base64,([A-Za-z0-9+/=]+)"', m.group(1))
ids = [k for k, _ in pairs]
if ids != SOUND_IDS: sys.exit('ABORT: SOUNDS keys differ: %r' % ids)
rebuilt = ','.join('%s:"data:audio/mpeg;base64,%s"' % p for p in pairs)
if rebuilt != m.group(1): sys.exit('ABORT: SOUNDS holds something other than 16 data URIs')
clips = {k: base64.b64decode(v, validate=True) for k, v in pairs}
for k, data in clips.items():
    if not (data[:3] == b'ID3' or data[:2] in (b'\xff\xfb', b'\xff\xf3', b'\xff\xf2')):
        sys.exit('ABORT: %s does not decode to an MP3' % k)
new_sounds = ('const SOUNDS={' + ','.join('%s:"audio/%s.mp3"' % (k, k) for k in ids) + '};\n')
OLD_SND_COMMENT = '/* ---------- level-up sounds (embedded) ---------- */'
one(bi, OLD_SND_COMMENT, 'sounds comment')

# ── 3. ttrpg ─────────────────────────────────────────────────────────────
OLD_SB = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2"></script>'
one(ti, OLD_SB, 'supabase tag')
NEW_SB = '<script src="https://cdn.jsdelivr.net/npm/@supabase/supabase-js@%s"></script>' % SUPABASE_PIN
cv = re.search(r"const CACHE_VERSION = '([^']+)';", tw)
if not cv or tw.count('const CACHE_VERSION = ') != 1: sys.exit('ABORT: ttrpg CACHE_VERSION not found once')
if cv.group(1) == TTRPG_CV: sys.exit('ABORT: ttrpg CACHE_VERSION already ' + TTRPG_CV)

# ── all anchors held: write ──────────────────────────────────────────────
bw = bw.replace('const CACHE = "%s";' % BOARD_CV_OLD, 'const CACHE = "%s";' % BOARD_CV_NEW, 1)
bw = bw.replace(OLD_ACT, NEW_ACT, 1).replace(OLD_INST, NEW_INST, 1).replace(OLD_HEAD, NEW_HEAD, 1)
bw = bw.replace(OLD_ASSETS_END, NEW_ASSETS_END, 1)
bi = bi.replace(m.group(0), new_sounds, 1)
bi = bi.replace(OLD_SND_COMMENT, '/* ---------- level-up sounds: files in audio/ (v105; were inline base64) ---------- */', 1)
ti = ti.replace(OLD_SB, NEW_SB, 1)
tw = tw.replace(cv.group(1), TTRPG_CV, 1)
assert bi.count('`') == BT_B and ti.count('`') == BT_T, 'backtick count changed'
assert 'data:audio' not in bi, 'inline audio left behind'

(site / 'board' / 'audio').mkdir()
for k, data in clips.items(): (site / 'board' / 'audio' / (k + '.mp3')).write_bytes(data)
b_idx.write_text(bi, encoding='utf-8'); b_sw.write_text(bw, encoding='utf-8')
t_idx.write_text(ti, encoding='utf-8'); t_sw.write_text(tw, encoding='utf-8')
print('patched', site, '| board', BOARD_CV_OLD, '->', BOARD_CV_NEW, '| 16 clips',
      sum(len(d) for d in clips.values()), 'bytes | ttrpg', cv.group(1), '->', TTRPG_CV,
      '| supabase-js @2 ->', SUPABASE_PIN)
