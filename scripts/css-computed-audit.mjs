import fs from 'node:fs';
import path from 'node:path';
import { spawn } from 'node:child_process';

const argv = process.argv.slice(2);
const arg = (k, d) => { const h = argv.find((a) => a.startsWith('--' + k + '=')); return h ? h.slice(k.length + 3) : d; };
const MODE = arg('mode', 'verify');
const URL_ = arg('url', 'https://chillin-bfc.pages.dev/');
const PORT = Number(arg('port', '9333'));
const PROFILE = arg('profile', path.resolve('backups/_css_audit_profile'));
const CAND = arg('candidate', path.resolve('public/style.css'));
const CANDLIST = arg('candidates', null);
const OUT = arg('out', path.resolve('backups/css-audit-out.json'));
const CHROME = arg('chrome', 'C:/Program Files/Google/Chrome/Application/chrome.exe');
const ATTACH = argv.includes('--attach');
const JPEG = "\nwindow.__audit = (function () {\n  var link = null;\n  var links = document.querySelectorAll('link[rel=\"stylesheet\"]');\n  for (var i = 0; i < links.length; i++) { var h = links[i].getAttribute('href') || ''; if (h.indexOf('style.css') >= 0) link = links[i]; }\n  if (!link) return { error: 'stylesheet link not found' };\n  var sheet = document.createElement('style');\n  sheet.id = '__css_computed_audit';\n  link.parentNode.insertBefore(sheet, link);\n  link.disabled = true;\n  var base = '', ref = null, offs = null, NAMES = null;\n  var BODY_CLS = ['dark-reader-body','eyecare-reader-body','in-reader-book','hide-bottom-nav','is-loading','is-offline','is-syncing','keyboard-open','not-authenticated'];\n  var HTML_CLS = ['ios-pwa','in-reader-book','dark-reader-body','eyecare-reader-body'];\n  function tokens(text) {\n    var m = text.match(/--[a-zA-Z0-9-]+/g) || [], seen = {}, out = [];\n    for (var i = 0; i < m.length; i++) { if (!seen[m[i]]) { seen[m[i]] = 1; out.push(m[i]); } }\n    return out;\n  }\n  function buildNames() {\n    var probe = document.body, cs = getComputedStyle(probe), names = [];\n    for (var i = 0; i < cs.length; i++) names.push(cs[i]);\n    var extra = tokens(base);\n    for (var j = 0; j < extra.length; j++) names.push(extra[j]);\n    names.push('__rect');\n    return names;\n  }\n  function reveal() {\n    var secs = document.querySelectorAll('.view-section');\n    for (var i = 0; i < secs.length; i++) { secs[i].classList.add('active'); secs[i].style.display = 'block'; }\n    var mods = document.querySelectorAll('.modal-overlay');\n    for (var j = 0; j < mods.length; j++) {\n      mods[j].classList.add('active'); mods[j].classList.add('show');\n      mods[j].style.display = 'block'; mods[j].style.opacity = '1'; mods[j].style.visibility = 'visible';\n    }\n  }\n  function setState(cfg) {\n    document.documentElement.setAttribute('data-theme', cfg.theme === 'dark' ? 'dark' : 'light');\n    for (var i = 0; i < BODY_CLS.length; i++) document.body.classList.toggle(BODY_CLS[i], cfg.body.indexOf(BODY_CLS[i]) >= 0);\n    for (var j = 0; j < HTML_CLS.length; j++) document.documentElement.classList.toggle(HTML_CLS[j], cfg.html.indexOf(HTML_CLS[j]) >= 0);\n  }\n  function desc(el) {\n    var s = el.tagName.toLowerCase();\n    if (el.id) s += '#' + el.id;\n    var c = (el.className || '').toString().trim().replace(/\\s+/g, '.').split('.').slice(0, 3).join('.');\n    if (c) s += '.' + c;\n    return s;\n  }\n  function snapshot() {\n    var els = document.querySelectorAll('body *'), n = NAMES.length, out = new Array(els.length);\n    for (var i = 0; i < els.length; i++) {\n      var cs = getComputedStyle(els[i]), vals = new Array(n);\n      for (var p = 0; p < n - 1; p++) vals[p] = cs.getPropertyValue(NAMES[p]);\n      var r = els[i].getBoundingClientRect();\n      vals[n - 1] = Math.round(r.width) + 'x' + Math.round(r.height) + '@' + Math.round(r.left) + ',' + Math.round(r.top);\n      out[i] = vals;\n    }\n    return out;\n  }\n  function diffSnap(a, b) {\n    var diffs = [], els = document.querySelectorAll('body *');\n    for (var i = 0; i < a.length && diffs.length < 60; i++) {\n      if (!b[i]) { diffs.push({ el: desc(els[i]), prop: '(missing)' }); continue; }\n      for (var p = 0; p < NAMES.length; p++) {\n        if (a[i][p] !== b[i][p]) {\n          diffs.push({ el: desc(els[i]), prop: NAMES[p], from: String(a[i][p]).slice(0, 60), to: String(b[i][p]).slice(0, 60) });\n          if (diffs.length >= 60) break;\n        }\n      }\n    }\n    return diffs;\n  }\n  function expand(declText) {\n    var probe = document.createElement('div').style;\n    probe.cssText = declText;\n    var out = [];\n    for (var i = 0; i < probe.length; i++) out.push(probe[i]);\n    return out;\n  }\n  function offsets() {\n    if (offs) return offs;\n    offs = []; var idx = 0;\n    while (true) { var at = base.indexOf('!important', idx); if (at < 0) break; offs.push(at); idx = at + 10; }\n    return offs;\n  }\n  function readProps(el, pseudo, props) {\n    if (!props) {\n      var names = NAMES, v = new Array(names.length);\n      var csAll = getComputedStyle(el, pseudo || undefined);\n      for (var q = 0; q < names.length - 1; q++) v[q] = csAll.getPropertyValue(names[q]);\n      return v;\n    }\n    var cs = getComputedStyle(el, pseudo || undefined), out = new Array(props.length);\n    for (var r = 0; r < props.length; r++) out[r] = cs.getPropertyValue(props[r]);\n    return out;\n  }\n  return {\n    ready: function (baseCss) {\n      base = baseCss; sheet.textContent = base;\n      NAMES = buildNames();\n      return { names: NAMES.length, tokens: tokens(base).length, els: document.querySelectorAll('body *').length };\n    },\n    reveal: reveal,\n    setState: setState,\n    begin: function (cfg) { setState(cfg); sheet.textContent = base; ref = snapshot(); return ref.length; },\n    compare: function (candCss) { sheet.textContent = candCss; var cur = snapshot(); var d = diffSnap(ref, cur); sheet.textContent = base; return d; },\n    match: function (list, targets) {\n      var out = [];\n      for (var i = 0; i < list.length; i++) {\n        var sel = list[i].sel.replace(/::([a-zA-Z-]+)/g, '');\n        var els; try { els = document.querySelectorAll(sel); } catch (e) { continue; }\n        var hit = [];\n        for (var e = 0; e < els.length; e++) { var d = desc(els[e]); if (targets.indexOf(d) >= 0) hit.push(d); }\n        if (hit.length) out.push({ id: list[i].id, els: hit.slice(0, 3) });\n      }\n      return out;\n    },\n    scan: function (list) {\n      var off = offsets(), res = [];\n      for (var i = 0; i < list.length; i++) {\n        var c = list[i], item = { id: c.id, verdict: '' };\n        var pseudo = '';\n        var sel = c.sel.replace(/::([a-zA-Z-]+)/g, function (m, p) { pseudo = '::' + p; return ''; });\n        var els;\n        try { els = document.querySelectorAll(sel); } catch (e) { item.verdict = 'bad-selector'; res.push(item); continue; }\n        if (!els.length) { item.verdict = 'nomatch'; res.push(item); continue; }\n        if (pseudo && pseudo !== '::after' && pseudo !== '::before') { item.verdict = 'pseudo-skip'; res.push(item); continue; }\n        var at = off[c.k];\n        if (at === undefined) { item.verdict = 'offset-miss'; res.push(item); continue; }\n        var props = expand(c.decl);\n        var useAll = (!props.length || props.join(',').indexOf('--') >= 0);\n        sheet.textContent = base;\n        var before = [];\n        for (var e = 0; e < els.length; e++) before.push(readProps(els[e], pseudo, useAll ? null : props));\n        sheet.textContent = base.slice(0, at) + base.slice(at + 9);\n        var dcount = 0;\n        for (var e2 = 0; e2 < els.length; e2++) {\n          var after = readProps(els[e2], pseudo, useAll ? null : props);\n          for (var t = 0; t < after.length; t++) if (after[t] !== before[e2][t]) dcount++;\n        }\n        sheet.textContent = base;\n        item.n = els.length; item.diff = dcount; item.el0 = desc(els[0]);\n        item.verdict = dcount === 0 ? 'same' : 'diff';\n        res.push(item);\n      }\n      return res;\n    }\n  };\n})();\n'installed';\n";

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function cdpHttp(p, init) { const r = await fetch('http://127.0.0.1:' + PORT + p, init); return r.json(); }

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); }
  static async connect(wsUrl) {
    const ws = new WebSocket(wsUrl);
    const c = new Cdp(ws);
    ws.addEventListener('message', (ev) => {
      const msg = JSON.parse(ev.data);
      if (msg.id && c.pending.has(msg.id)) { const pk = c.pending.get(msg.id); c.pending.delete(msg.id); msg.error ? pk.rej(new Error(JSON.stringify(msg.error))) : pk.res(msg.result); }
    });
    await new Promise((res, rej) => { ws.addEventListener('open', res); ws.addEventListener('error', rej); });
    return c;
  }
  send(method, params) { const id = ++this.id; this.ws.send(JSON.stringify({ id, method, params: params || {} })); return new Promise((res, rej) => this.pending.set(id, { res, rej })); }
  async eval(expr) {
    const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true });
    if (r.exceptionDetails) throw new Error('page eval: ' + JSON.stringify(r.exceptionDetails).slice(0, 300) + ' :: ' + expr.slice(0, 120));
    return r.result.value;
  }
}

const LINK_LOOKUP = 'Array.from(document.querySelectorAll("link[rel=stylesheet]")).filter(function(x){return (x.getAttribute("href")||"").indexOf("style.css")>=0})[0]';

const ENVS = [
  { name: 'w1024', w: 1024, mobile: false, media: [] },
  { name: 'w768', w: 768, mobile: true, media: [] },
  { name: 'w640', w: 640, mobile: true, media: [] },
  { name: 'w480', w: 480, mobile: true, media: [] },
  { name: 'w390', w: 390, mobile: true, media: [] },
  { name: 'hoverdark', w: 1024, mobile: false, media: [{ name: 'hover', value: 'hover' }, { name: 'pointer', value: 'fine' }, { name: 'prefers-color-scheme', value: 'dark' }] },
  { name: 'nomotion', w: 390, mobile: true, media: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }
];
const SCAN_ENVS = ENVS.filter((e) => e.name === 'w1024' || e.name === 'w390');
const SCAN_STATES = [
  { body: [], html: [] },
  { body: ['in-reader-book'], html: ['in-reader-book'] },
  { body: ['dark-reader-body'], html: [] }
];
const STATES = [
  { body: [], html: [] },
  { body: ['in-reader-book'], html: ['in-reader-book'] },
  { body: ['dark-reader-body'], html: [] },
  { body: ['eyecare-reader-body'], html: [] },
  { body: ['in-reader-book', 'dark-reader-body'], html: ['in-reader-book'] },
  { body: ['in-reader-book', 'eyecare-reader-body'], html: ['in-reader-book'] },
  { body: ['not-authenticated'], html: [] },
  { body: ['is-offline'], html: [] },
  { body: ['is-syncing'], html: [] },
  { body: ['is-loading'], html: [] },
  { body: ['keyboard-open'], html: [] },
  { body: ['hide-bottom-nav'], html: [] },
  { body: [], html: ['ios-pwa'] }
];

async function openPage(cdp) {
  let probe = null;
  for (let attempt = 1; attempt <= 5; attempt++) {
    await cdp.send('Page.navigate', { url: 'about:blank' });
    await sleep(400);
    await cdp.send('Page.navigate', { url: URL_ });
    for (let i = 0; i < 60; i++) { await sleep(500); const rs = await cdp.eval('document.readyState'); if (rs === 'complete') break; }
    await sleep(2000);
    probe = JSON.parse(await cdp.eval('JSON.stringify({ href: location.href, title: document.title, link: !!(' + LINK_LOOKUP + '), els: document.querySelectorAll("body *").length, text: (document.body.innerText || "").slice(0, 120) })'));
    console.log('page (attempt ' + attempt + '): ' + JSON.stringify(probe));
    if (probe.link) return probe;
    await sleep(2500);
  }
  return probe;
}

const main = async () => {
  let chrome = null;
  if (!ATTACH) {
    chrome = spawn(CHROME, ['--headless=new', '--remote-debugging-port=' + PORT, '--user-data-dir=' + PROFILE, '--no-first-run', '--no-default-browser-check', '--disable-extensions', '--window-size=1024,900', 'about:blank'], { stdio: 'ignore' });
  }
  try {
    let up = false;
    for (let i = 0; i < 60 && !up; i++) { try { await cdpHttp('/json/version'); up = true; } catch { await sleep(500); } }
    if (!up) throw new Error('Chrome CDP 未就绪: 127.0.0.1:' + PORT);
    const tab = await cdpHttp('/json/new?about:blank', { method: 'PUT' });
    const cdp = await Cdp.connect(tab.webSocketDebuggerUrl);
    await cdp.send('Page.enable'); await cdp.send('Runtime.enable');
    await cdp.send('Emulation.setDeviceMetricsOverride', { width: 1024, height: 900, deviceScaleFactor: 1, mobile: false });
    const probe = await openPage(cdp);
    if (!probe || !probe.link) { console.log('ABORT: 页面上没有 style.css 链接（可能加载失败或未登录）。'); return; }
    const baseCss = await cdp.eval('fetch((' + LINK_LOOKUP + ').href).then(function(r){return r.text()})');
    console.log('baseCss bytes=' + baseCss.length);
    const local = fs.readFileSync(CAND, 'utf8');
    console.log('local candidate bytes=' + local.length + ' identical=' + (local === baseCss));
    await cdp.eval(JPEG);
    const installed = JSON.parse(await cdp.eval('JSON.stringify(window.__audit.ready(' + JSON.stringify(baseCss) + '))'));
    console.log('installed: ' + JSON.stringify(installed));
    await cdp.eval('window.__audit.reveal()');
    console.log('revealed els=' + await cdp.eval('document.querySelectorAll("body *").length'));
    if (MODE === 'verify') {
      await cdp.eval('window.__candCss = window.__baseCss = ' + JSON.stringify(baseCss) + '; 1');
      await cdp.eval('window.__realCss = ' + JSON.stringify(local) + '; 1');
      const LIMIT = Number(arg('limit', '0'));
      const report = [], control = [];
      let done = 0;
      const VENVS = (() => { const f = arg('envs', ''); return f ? ENVS.filter((e) => f.split(',').indexOf(e.name) >= 0) : ENVS; })();
      for (const env of VENVS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: env.w, height: 900, deviceScaleFactor: 1, mobile: env.mobile });
        await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: env.media });
        for (const st of STATES) {
          for (const theme of ['light', 'dark']) {
            if (LIMIT && done >= LIMIT) break;
            const t0 = Date.now();
            const cfg = JSON.stringify({ theme, body: st.body, html: st.html });
            await cdp.eval('window.__audit.begin(' + cfg + ')');
            const cd = JSON.parse(await cdp.eval('JSON.stringify(window.__audit.compare(window.__baseCss).slice(0, 4))'));
            await cdp.eval('window.__audit.begin(' + cfg + ')');
            const diffs = JSON.parse(await cdp.eval('JSON.stringify(window.__audit.compare(window.__realCss).slice(0, 40))'));
            done++;
            const tag = env.name + '/' + theme + '/' + (st.body.concat(st.html).join('+') || 'default');
            if (cd.length) control.push({ ctx: tag, diffs: cd });
            if (diffs.length) report.push({ env: env.name, state: st.body.concat(st.html).join('+') || 'default', theme, diffs });
            if (process.env.AUDIT_VERBOSE) console.log('  ctx ' + done + ' ' + tag + ' ' + (Date.now() - t0) + 'ms control=' + cd.length + ' diffs=' + diffs.length);
          }
        }
        console.log('env ' + env.name + ' done (' + done + ' contexts), diff contexts=' + report.length + ' controlFail=' + control.length);
        if (LIMIT && done >= LIMIT) break;
      }
      fs.writeFileSync(OUT, JSON.stringify({ control, report }, null, 1));
      console.log('TOTAL contexts=' + done + ' controlFail=' + control.length + ' diff contexts=' + report.length);
      if (control.length) console.log('CONTROL FAIL: ' + JSON.stringify(control.slice(0, 2)));
      console.log('DIFF sample: ' + JSON.stringify(report.slice(0, 3)).slice(0, 2000));
    }
    if (MODE === 'scan') {
      const cands = JSON.parse(fs.readFileSync(CANDLIST, 'utf8'));
      console.log('candidates=' + cands.length);
      const agg = new Map();
      const LIMIT = Number(arg('limit', '0'));
      const SCAN_MATRIX = arg('matrix', 'scan') === 'full' ? { envs: ENVS, states: STATES } : { envs: SCAN_ENVS, states: SCAN_STATES };
      console.log('scan matrix envs=' + SCAN_MATRIX.envs.map((e) => e.name).join(',') + ' states=' + SCAN_MATRIX.states.length + ' contexts=' + (SCAN_MATRIX.envs.length * SCAN_MATRIX.states.length * 2));
      let done = 0;
      for (const env of SCAN_MATRIX.envs) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: env.w, height: 900, deviceScaleFactor: 1, mobile: env.mobile });
        await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: env.media });
        for (const st of SCAN_MATRIX.states) {
          for (const theme of ['light', 'dark']) {
            const t0 = Date.now();
            if (LIMIT && done >= LIMIT) break;
            await cdp.eval('window.__audit.setState(' + JSON.stringify({ theme, body: st.body, html: st.html }) + ')');
            const res = JSON.parse(await cdp.eval('JSON.stringify(window.__audit.scan(' + JSON.stringify(cands) + '))'));
            for (const it of res) {
              if (it.verdict === 'nomatch' || it.verdict === 'bad-selector' || it.verdict === 'pseudo-skip') continue;
              let a = agg.get(it.id);
              if (!a) { a = { id: it.id, same: 0, diff: 0, diffExample: null, el0: it.el0, n: it.n }; agg.set(it.id, a); }
              if (it.verdict === 'same') a.same++;
              else if (it.verdict === 'diff') { a.diff++; if (!a.diffExample) a.diffExample = { env: env.name, state: st.body.concat(st.html).join('+') || 'default', theme, n: it.diff, el0: it.el0 }; }
            }
            done++;
            console.log('  scan ctx ' + done + ' ' + env.name + '/' + theme + '/' + (st.body.join('+') || '-') + ' ' + (Date.now() - t0) + 'ms');
          }
        }
        console.log('scan env ' + env.name + ' done (' + done + ' contexts)');
        if (LIMIT && done >= LIMIT) break;
      }
      const arr = [...agg.values()];
      const safe = arr.filter((a) => a.diff === 0 && a.same > 0);
      const unsafe = arr.filter((a) => a.diff > 0);
      const untested = cands.filter((c) => !agg.has(c.id)).map((c) => c.id);
      fs.writeFileSync(OUT, JSON.stringify({ safe: safe.map((s) => s.id), unsafe, untested, all: arr }, null, 1));
      console.log('scan contexts=' + done + ' measured=' + arr.length + ' safe=' + safe.length + ' unsafe=' + unsafe.length + ' untested=' + untested.length);
      console.log('SAFE: ' + JSON.stringify(safe.map((s) => s.id)));
      console.log('UNSAFE sample: ' + JSON.stringify(unsafe.slice(0, 8)));
      console.log('UNTESTED: ' + JSON.stringify(untested));
    }
    if (MODE === 'match') {
      const cands = JSON.parse(fs.readFileSync(CANDLIST, 'utf8'));
      const TF = arg('targetsfile', null);
      const targets = TF ? JSON.parse(fs.readFileSync(TF, 'utf8')) : JSON.parse(arg('targets', '[]'));
      const f = arg('envs', 'w1024');
      const MENVS = f ? ENVS.filter((e) => f.split(',').indexOf(e.name) >= 0) : ENVS;
      const hits = new Map();
      for (const env of MENVS) {
        await cdp.send('Emulation.setDeviceMetricsOverride', { width: env.w, height: 900, deviceScaleFactor: 1, mobile: env.mobile });
        await cdp.send('Emulation.setEmulatedMedia', { media: 'screen', features: env.media });
        for (const st of STATES) {
          for (const theme of ['light', 'dark']) {
            await cdp.eval('window.__audit.setState(' + JSON.stringify({ theme, body: st.body, html: st.html }) + ')');
            const res = JSON.parse(await cdp.eval('JSON.stringify(window.__audit.match(' + JSON.stringify(cands) + ',' + JSON.stringify(targets) + '))'));
            for (const h of res) {
              if (!hits.has(h.id)) hits.set(h.id, []);
              hits.get(h.id).push(st.body.concat(st.html).join('+') || 'default');
            }
          }
        }
      }
      const out = [...hits.entries()].map(([id, list]) => ({ id, states: list }));
      fs.writeFileSync(OUT, JSON.stringify(out, null, 1));
      console.log('MATCHED ' + out.length + ' of ' + cands.length);
      for (const o of out) { const c = cands.find((x) => x.id === o.id); console.log(o.id + ' | ' + c.sel.slice(0, 64) + ' | ' + c.decl.slice(0, 56) + ' | ' + o.states.join(',')); }
    }
  } finally {
    if (chrome) chrome.kill('SIGKILL');
  }
};
main().then(() => process.exit(0)).catch((e) => { console.error('FAIL ' + e.message); process.exit(1); });
