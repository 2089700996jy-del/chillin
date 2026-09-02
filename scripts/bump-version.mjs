/**
 * One-command version bump for Chillin.
 *
 * Usage:
 *   node scripts/bump-version.mjs              # patch +1 (2.5.11 -> 2.5.12)
 *   node scripts/bump-version.mjs patch
 *   node scripts/bump-version.mjs minor
 *   node scripts/bump-version.mjs major
 *   node scripts/bump-version.mjs 2.6.0
 *   node scripts/bump-version.mjs patch --dry-run
 */
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const root = path.resolve(__dirname, '..');

const args = process.argv.slice(2).filter((a) => a !== '--');
const dryRun = args.includes('--dry-run');
const targetArg = args.find((a) => !a.startsWith('--')) || 'patch';

function read(rel) {
    return fs.readFileSync(path.join(root, rel), 'utf8');
}

function write(rel, content) {
    const full = path.join(root, rel);
    if (dryRun) {
        console.log(`[dry-run] would write ${rel}`);
        return;
    }
    fs.writeFileSync(full, content, 'utf8');
    console.log(`updated ${rel}`);
}

function parseSemver(v) {
    const m = String(v).trim().match(/^(\d+)\.(\d+)\.(\d+)$/);
    if (!m) throw new Error(`Invalid semver: ${v}`);
    return { major: +m[1], minor: +m[2], patch: +m[3] };
}

function formatSemver({ major, minor, patch }) {
    return `${major}.${minor}.${patch}`;
}

function bumpKind(cur, kind) {
    const s = parseSemver(cur);
    if (kind === 'major') return formatSemver({ major: s.major + 1, minor: 0, patch: 0 });
    if (kind === 'minor') return formatSemver({ major: s.major, minor: s.minor + 1, patch: 0 });
    if (kind === 'patch') return formatSemver({ major: s.major, minor: s.minor, patch: s.patch + 1 });
    return formatSemver(parseSemver(kind));
}

function replaceAll(str, from, to) {
    return str.split(from).join(to);
}

// --- read current ---
const versionJs = read('js/version.js');
const curMatch = versionJs.match(/APP_VERSION\s*=\s*['"]([\d.]+)['"]/);
if (!curMatch) throw new Error('Cannot find APP_VERSION in js/version.js');
const current = curMatch[1];
const next = bumpKind(current, targetArg);

const sw = read('sw.js');
const cacheMatch = sw.match(/CACHE_NAME\s*=\s*['"]chillin-v(\d+)['"]/);
if (!cacheMatch) throw new Error('Cannot find CACHE_NAME in sw.js');
const nextCache = `chillin-v${Number(cacheMatch[1]) + 1}`;

console.log(`bump ${current} -> ${next}`);
console.log(`CACHE_NAME ${cacheMatch[0].match(/chillin-v\d+/)[0]} -> ${nextCache}`);
if (dryRun) console.log('(dry-run: no files written)');

// js/version.js
write(
    'js/version.js',
    `/** Single source of truth for the visible app version (bump with cache ?v=). */\n` +
        `export const APP_VERSION = '${next}';\n` +
        `export const APP_BUILD_LABEL = \`v\${APP_VERSION}\`;\n`
);

// version.json
write('version.json', JSON.stringify({ version: next, build: `v${next}` }, null, 0) + '\n');

// workers/api.js — first APP_VERSION const near top
{
    let w = read('workers/api.js');
    const replaced = w.replace(
        /const APP_VERSION = ['"][\d.]+['"]/,
        `const APP_VERSION = '${next}'`
    );
    if (replaced === w) throw new Error('workers/api.js APP_VERSION not found');
    write('workers/api.js', replaced);
}

// sw.js
{
    let s = read('sw.js');
    s = s.replace(/const CACHE_NAME = ['"]chillin-v\d+['"]/, `const CACHE_NAME = '${nextCache}'`);
    s = s.replace(/const APP_V = ['"][\d.]+['"]/, `const APP_V = '${next}'`);
    write('sw.js', s);
}

// index.html — ?v= and badge text vX.Y.Z
{
    let html = read('index.html');
    html = replaceAll(html, `?v=${current}`, `?v=${next}`);
    html = replaceAll(html, `>v${current}<`, `>v${next}<`);
    // also catch title/placeholder if only badge uses v prefix with current
    if (html.includes(`?v=${current}`) || html.includes(`>v${current}<`)) {
        throw new Error('index.html still contains old version after replace');
    }
    write('index.html', html);
}

// PROGRESS.md header version line (best-effort)
{
    const progressPath = 'PROGRESS.md';
    if (fs.existsSync(path.join(root, progressPath))) {
        let p = read(progressPath);
        const nextP = p
            .replace(/\*\*v[\d.]+\*\*/g, `**v${next}**`)
            .replace(/当前前端\/Worker：\*\*v[\d.]+\*\*/, `当前前端/Worker：**v${next}**`);
        if (nextP !== p) write(progressPath, nextP);
        else console.log('skip PROGRESS.md (no version header match)');
    }
}

console.log('');
console.log('Next:');
console.log('  npx wrangler deploy');
console.log('  git add -A && git commit && git push');
