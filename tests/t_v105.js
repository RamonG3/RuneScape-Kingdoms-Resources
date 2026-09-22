/* t_v105.js — v105: board sounds to files, board cache cleanup, supabase pin.
   node tests/t_v105.js <v105 site> <v104 site> <supabase.js for the pin>

   Real pages and real service workers in Playwright Chromium, each site
   served over http from disk on its own port (a port is an origin, so every
   scenario starts with empty CacheStorage). jsDelivr is answered from the
   local copy of the pinned supabase-js build; Supabase itself and Google
   Fonts are refused, as offline. Every scenario that asserts a fix also runs
   against v104, or a deliberately broken copy, and must come out red there. */
'use strict';
const fs = require('fs'), path = require('path'), http = require('http'), os = require('os');
const { chromium } = require(process.env.PLAYWRIGHT || 'playwright');

const V105 = path.resolve(process.argv[2] || 'v105pub');
const V104 = path.resolve(process.argv[3] || 'pub');
const SBJS = path.resolve(process.argv[4] || 'supabase.js');
const PIN = '2.116.0';
const IDS = ['prayer', 'summoning', 'runecrafting', 'quest', 'coins', 'death', 'ohdear', 'damage',
             'melee', 'ranged', 'magic', 'defence', 'thieving', 'gathering', 'crafting', 'cooking'];
let pass = 0, fail = 0;
function ok(c, m){ if(c){ pass++; } else { fail++; console.log('  FAIL ' + m); } }
function eq(a, b, m){ ok(a === b, m + '  (got ' + JSON.stringify(a) + ', want ' + JSON.stringify(b) + ')'); }
const sleep = ms => new Promise(r => setTimeout(r, ms));

const TYPES = { '.html':'text/html', '.js':'text/javascript', '.json':'application/json', '.png':'image/png',
  '.webp':'image/webp', '.mp3':'audio/mpeg', '.ogg':'audio/ogg', '.m4a':'audio/mp4', '.pdf':'application/pdf',
  '.webmanifest':'application/manifest+json', '.xml':'application/xml', '.txt':'text/plain' };
function serve(root){
  return new Promise(res => {
    const srv = http.createServer((req, rsp) => {
      let p = decodeURIComponent(req.url.split('?')[0]);
      if(p.endsWith('/')) p += 'index.html';
      const f = path.join(root, p);
      if(!f.startsWith(root) || !fs.existsSync(f) || fs.statSync(f).isDirectory()){ rsp.writeHead(404); return rsp.end('nf'); }
      rsp.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream' });
      fs.createReadStream(f).pipe(rsp);
    });
    /* "localhost", not 127.0.0.1: the board page only registers its worker
       on https: or on a hostname of exactly localhost */
    srv.listen(0, () => res({ srv, base: 'http://localhost:' + srv.address().port }));
  });
}
function copySite(src, tweak){
  const dst = fs.mkdtempSync(path.join(os.tmpdir(), 'v105-'));
  fs.cpSync(src, dst, { recursive: true });
  if(tweak) tweak(dst);
  return dst;
}

let browser;
async function context(opts){
  const ctx = await browser.newContext(opts);
  const sbRequests = [];
  await ctx.route(/cdn\.jsdelivr\.net/, r => {
    sbRequests.push(r.request().url());
    if(/supabase-js/.test(r.request().url()))
      return r.fulfill({ status: 200, contentType: 'text/javascript', body: fs.readFileSync(SBJS) });
    return r.abort();
  });
  await ctx.route(/supabase\.co|googleapis|gstatic/, r => r.abort());
  ctx.sbRequests = sbRequests;
  return ctx;
}
/* a page may reload itself when its worker takes control (the TTRPG one
   does, on controllerchange), so every probe tolerates a navigation */
async function probe(page, fn, arg){
  for(let i = 0; i < 40; i++){
    try{ return await page.evaluate(fn, arg); }
    catch(e){ if(!/context was destroyed|navigation/i.test(e.message)) throw e; await sleep(250); }
  }
  throw new Error('page never settled');
}
async function waitActive(page, scope){
  const t0 = Date.now();
  while(Date.now() - t0 < 20000){
    const st = await probe(page, async scope => {
      const reg = await navigator.serviceWorker.getRegistration(scope);
      return !!(reg && reg.active && !reg.installing && !reg.waiting);
    }, scope);
    if(st) return true;
    await sleep(150);
  }
  return false;
}
async function waitCache(page, name){
  const t0 = Date.now();
  while(Date.now() - t0 < 10000){
    if((await probe(page, () => caches.keys())).includes(name)) return true;
    await sleep(150);
  }
  return false;
}
const cacheKeys = page => probe(page, () => caches.keys());
async function cachedUrls(page, name){
  return probe(page, async name => {
    const c = await caches.open(name);
    return (await c.keys()).map(r => new URL(r.url).pathname);
  }, name);
}
/* plays every id through the page's own playSound (via the RSK_BOARD seam)
   and reports, per id, whether the element it created decoded real audio */
async function playAll(page, ids){
  return page.evaluate(async ids => {
    const out = {};
    for(const id of ids){
      window.__made = [];
      window.RSK_BOARD.playSound(id);
      const a = window.__made[window.__made.length - 1];
      if(!a){ out[id] = 'no element'; continue; }
      out[id] = await new Promise(res => {
        const done = v => res(v);
        if(a.readyState >= 1 && a.duration > 0) return done('ok');
        a.addEventListener('loadedmetadata', () => done(a.duration > 0 ? 'ok' : 'zero duration'));
        a.addEventListener('error', () => done('error ' + (a.error && a.error.code)));
        setTimeout(() => done('timeout rs=' + a.readyState), 8000);
      });
    }
    return out;
  }, ids);
}
const RECORD_AUDIO = () => {
  const A = window.Audio;
  window.Audio = function(src){ const a = new A(src); (window.__made = window.__made || []).push(a); return a; };
  window.Audio.prototype = A.prototype;
};

(async function main(){
  browser = await chromium.launch({ args: ['--autoplay-policy=no-user-gesture-required'] });

  /* ── 1. static: the files are the bytes that were inline ──────────────── */
  console.log('1. extracted clips');
  const src104 = fs.readFileSync(path.join(V104, 'board', 'index.html'), 'utf8');
  const src105 = fs.readFileSync(path.join(V105, 'board', 'index.html'), 'utf8');
  const inline = {};
  src104.replace(/(\w+):"data:audio\/mpeg;base64,([A-Za-z0-9+/=]+)"/g, (_, k, b) => { inline[k] = Buffer.from(b, 'base64'); });
  eq(JSON.stringify(Object.keys(inline)), JSON.stringify(IDS), 'v104 held the 16 expected clips inline');
  for(const id of IDS){
    const f = path.join(V105, 'board', 'audio', id + '.mp3');
    ok(fs.existsSync(f) && Buffer.compare(fs.readFileSync(f), inline[id]) === 0, id + '.mp3 is byte-identical to the inline clip');
  }
  eq(fs.readdirSync(path.join(V105, 'board', 'audio')).length, 16, 'no stray files in board/audio');
  ok(!/data:audio/.test(src105), 'no inline audio left in the page');
  ok(src105.length < 130000, 'board page is now ' + src105.length + ' bytes');
  /* everything but the SOUNDS object and its comment line is unchanged */
  const strip = s => s.replace(/const SOUNDS=\{.*?\};\n/s, '').replace(/\/\* -+ level-up sounds.*\n/, '');
  eq(strip(src105), strip(src104), 'rest of the board page is byte-identical');
  const t104 = fs.readFileSync(path.join(V104, 'ttrpg', 'index.html'), 'utf8');
  const t105 = fs.readFileSync(path.join(V105, 'ttrpg', 'index.html'), 'utf8');
  eq(t105, t104.replace('supabase-js@2"', 'supabase-js@' + PIN + '"'), 'ttrpg page differs by the pin only');
  eq((t105.match(/`/g) || []).length, (t104.match(/`/g) || []).length, 'backtick count unchanged');
  ok(/supabase-js/.test('https://cdn.jsdelivr.net/npm/@supabase/supabase-js@' + PIN), 'harness CDN matcher still matches');
  const bsw = fs.readFileSync(path.join(V105, 'board', 'sw.js'), 'utf8');
  const assets = eval(/const ASSETS = (\[[\s\S]*?\]);/.exec(bsw)[1]);
  eq(assets.length, 33, 'ASSETS is still the 33 atomic entries');
  ok(assets.every(a => fs.existsSync(path.join(V105, 'board', a === './' ? 'index.html' : a))), 'every ASSETS entry exists');
  ok(!assets.some(a => /audio\//.test(a)), 'no audio in the atomic list');

  /* ── 2. the board no longer wipes the TTRPG cache ─────────────────────── */
  console.log('2. shared CacheStorage');
  async function ttrpgThenBoard(site){
    const { srv, base } = await serve(site);
    const ctx = await context(); const p = await ctx.newPage();
    await p.goto(base + '/ttrpg/'); await waitActive(p, base + '/ttrpg/'); await sleep(1500);
    const before = (await cacheKeys(p)).filter(k => k.startsWith('rsk-cache-'));
    const nBefore = before.length ? (await cachedUrls(p, before[0])).length : 0;
    await p.goto(base + '/board/'); await waitActive(p, base + '/board/');
    await waitCache(p, 'rsk-sheet-' + (site === V104 ? 'v8.17' : 'v8.18')); await sleep(1000);
    const after = await cacheKeys(p);
    await ctx.close(); srv.close();
    return { before, nBefore, after };
  }
  const r105 = await ttrpgThenBoard(V105);
  eq(r105.before.length, 1, 'v105: the TTRPG worker made its cache');
  ok(r105.nBefore > 40, 'v105: holding its shell and audio (' + r105.nBefore + ' entries)');
  ok(r105.after.includes(r105.before[0]), 'v105: it survives the board worker activating ' + JSON.stringify(r105.after));
  ok(r105.after.includes('rsk-sheet-v8.18'), 'v105: board cache is rsk-sheet-v8.18');
  const r104 = await ttrpgThenBoard(V104);
  ok(r104.before.length === 1 && !r104.after.includes(r104.before[0]), 'control: v104 wipes it (the bug is real and this test sees it)');
  /* the board still cleans up its OWN old caches */
  {
    const { srv, base } = await serve(V105);
    const ctx = await context(); const p = await ctx.newPage();
    await p.goto(base + '/landing/board-game.webp');
    await p.evaluate(async () => { await caches.open('rsk-sheet-v8.17'); await caches.open('rsk-audio-v1'); await caches.open('rsk-cache-x'); });
    await p.goto(base + '/board/'); await waitActive(p, base + '/board/'); await sleep(800);
    const k = await cacheKeys(p);
    ok(!k.includes('rsk-sheet-v8.17'), 'old board cache rsk-sheet-v8.17 is still deleted');
    ok(k.includes('rsk-audio-v1') && k.includes('rsk-cache-x'), 'other apps’ caches are left alone');
    await ctx.close(); srv.close();
  }

  /* ── 3. every sound plays, online and offline ─────────────────────────── */
  console.log('3. board sounds');
  {
    const { srv, base } = await serve(V105);
    const ctx = await context(); await ctx.addInitScript(RECORD_AUDIO);
    const p = await ctx.newPage(); const errs = []; p.on('pageerror', e => errs.push(e.message));
    await p.goto(base + '/board/'); ok(await waitActive(p, base + '/board/'), 'board worker installs and activates');
    const urls = await cachedUrls(p, 'rsk-sheet-v8.18');
    eq(IDS.filter(id => urls.includes('/board/audio/' + id + '.mp3')).length, 16, 'all 16 clips precached');
    eq(urls.length, 49, '33 assets + 16 clips in the cache');
    await p.reload(); await sleep(300);
    ok(await p.evaluate(() => !!navigator.serviceWorker.controller), 'page is controlled');
    const on = await playAll(p, IDS);
    eq(IDS.filter(id => on[id] === 'ok').length, 16, 'online: all 16 play ' + JSON.stringify(on));
    ok(await p.evaluate(() => window.__made.every(a => /\/board\/audio\/\w+\.mp3$/.test(a.src))), 'from board/audio/');
    await ctx.setOffline(true);
    const q = await ctx.newPage(); q.on('pageerror', e => errs.push(e.message));
    await q.goto(base + '/board/'); await sleep(500);
    const off = await playAll(q, IDS);
    eq(IDS.filter(id => off[id] === 'ok').length, 16, 'offline: all 16 play ' + JSON.stringify(off));
    eq(errs.length, 0, 'no page errors ' + errs.slice(0, 2).join(' | '));
    await ctx.close(); srv.close();
  }

  /* ── 4. a missing clip never fails the install; it caches on first play ─ */
  console.log('4. tolerant install');
  {
    const site = copySite(V105, d => fs.renameSync(path.join(d, 'board/audio/melee.mp3'), path.join(d, 'melee.hold')));
    const { srv, base } = await serve(site);
    const ctx = await context(); await ctx.addInitScript(RECORD_AUDIO);
    const p = await ctx.newPage();
    await p.goto(base + '/board/');
    ok(await waitActive(p, base + '/board/'), 'melee.mp3 missing: the worker still installs');
    const urls = await cachedUrls(p, 'rsk-sheet-v8.18');
    eq(urls.length, 48, 'everything else cached');
    ok(!urls.includes('/board/audio/melee.mp3'), 'melee not cached');
    fs.renameSync(path.join(site, 'melee.hold'), path.join(site, 'board/audio/melee.mp3'));   /* the file turns up */
    await p.reload(); await sleep(300);
    eq((await playAll(p, ['melee'])).melee, 'ok', 'plays online once it exists');
    await sleep(300);
    ok((await cachedUrls(p, 'rsk-sheet-v8.18')).includes('/board/audio/melee.mp3'), 'and was stored on the miss');
    await ctx.setOffline(true);
    const q = await ctx.newPage(); await q.goto(base + '/board/'); await sleep(500);
    eq((await playAll(q, ['melee'])).melee, 'ok', 'offline it plays from the cache');
    await ctx.close(); srv.close();
  }
  {
    /* control: the same missing file with the clips in the ATOMIC list must fail */
    const site = copySite(V105, d => {
      fs.unlinkSync(path.join(d, 'board/audio/melee.mp3'));
      const f = path.join(d, 'board/sw.js');
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('c.addAll(ASSETS)', 'c.addAll(ASSETS.concat(AUDIO))'));
    });
    const { srv, base } = await serve(site);
    const ctx = await context(); const p = await ctx.newPage();
    await p.goto(base + '/board/'); await sleep(3000);
    const active = await p.evaluate(async () => { const r = await navigator.serviceWorker.getRegistration(); return !!(r && r.active); });
    ok(!active, 'control: clips in the atomic list + one missing = no worker (why they are kept out)');
    await ctx.close(); srv.close();
  }

  /* ── 5. supabase pin ──────────────────────────────────────────────────── */
  console.log('5. supabase pin');
  async function ttrpgBoot(site){
    const { srv, base } = await serve(site);
    /* workers blocked: Playwright cannot route a worker's own fetches, and
       the pin is about what the PAGE loads, not about caching */
    const ctx = await context({ serviceWorkers: 'block' }); const p = await ctx.newPage(); const errs = [];
    p.on('pageerror', e => errs.push(e.message));
    await p.goto(base + '/ttrpg/'); await sleep(2500);
    const r = await p.evaluate(() => ({ lib: typeof (window.supabase && window.supabase.createClient),
      buttons: document.querySelectorAll('button').length }));
    const reqs = ctx.sbRequests.filter(u => /supabase-js/.test(u));
    await ctx.close(); srv.close();
    return Object.assign(r, { errs, reqs });
  }
  const b105 = await ttrpgBoot(V105), b104 = await ttrpgBoot(V104);
  eq(b105.reqs[0], 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@' + PIN, 'v105 requests the pinned URL');
  eq(b104.reqs[0], 'https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2', '(v104 requested the floating one)');
  eq(b105.lib, 'function', 'the library loads and exposes createClient');
  eq(JSON.stringify(b105.errs), JSON.stringify(b104.errs), 'same page errors as v104 with the same library (server refused in both)');
  eq(b105.buttons, b104.buttons, 'same UI built');

  await browser.close();
  console.log('\n' + pass + ' passed, ' + fail + ' failed');
  process.exit(fail ? 1 : 0);
})().catch(e => { console.error(e); process.exit(2); });
