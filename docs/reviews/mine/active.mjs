import fs from 'fs'; import path from 'path';
const runs = JSON.parse(fs.readFileSync('runs.json'));
const repos = { rollcall: process.env.HOME + '/Documents/Work/RollCall/rollcall', 'kwenta-web': process.env.HOME + '/Documents/Personal/kwenta-web', courtly: process.env.HOME + '/Documents/Personal/courtly' };
const ts = {};
for (const [k, root] of Object.entries(repos)) { const sd = path.join(root, '.claude/gate/sessions'); const a = [];
  for (const s of fs.readdirSync(sd)) { const f = path.join(sd, s, 'events.jsonl'); if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { const m = l.match(/"ts":"([^"]+)"/); if (m) a.push(Date.parse(m[1])); } }
  ts[k] = a.sort((x, y) => x - y); }
const CAP = 10 * 60000; const med = a => { a = [...a].sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null };
const rows = [];
for (const r of runs) { if (!ts[r.repo] || !r.closedAt) continue; const o = Date.parse(r.openedAt), c = Date.parse(r.closedAt);
  const e = ts[r.repo].filter(t => t >= o && t <= c); let act = 0; for (let i = 1; i < e.length; i++) act += Math.min(e[i] - e[i - 1], CAP);
  rows.push({ ...r, act: Math.round(act / 60000), nev: e.length }); }
const rebase = x => /rebase|checkout|after-4014|review-followup/.test(x.name) && x.reviewFiles === 0;
for (const v of ['0.19.0', '0.20.0']) for (const repo of ['rollcall', 'kwenta-web', 'courtly']) {
  const xs = rows.filter(x => x.version === v && x.repo === repo && x.nev > 5); if (!xs.length) continue;
  const L = xs.filter(x => x.measured === 'large' && !rebase(x));
  console.log(v, repo, 'runs w/ events', xs.length, 'active total', xs.reduce((a, x) => a + x.act, 0), 'min; median', med(xs.map(x => x.act)), '| real large', L.length, 'median active', med(L.map(x => x.act)), 'median reviews', med(L.map(x => x.reviewFiles)), L.map(x => x.name.slice(11, 40) + ':' + x.act).join(', '));
}
