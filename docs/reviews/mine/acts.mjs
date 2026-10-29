import fs from 'fs'; import path from 'path';
const roots = process.argv.slice(2); const rows = [];
for (const root of roots) { const rd = path.join(root, '.claude/gate/runs'); if (!fs.existsSync(rd)) continue;
  for (const n of fs.readdirSync(rd)) { const f = path.join(rd, n, 'ledger.json'); if (!fs.existsSync(f)) continue; const l = JSON.parse(fs.readFileSync(f));
    if (l.version !== '0.20.0') continue;
    for (const h of l.huddles || []) for (const a of h.actOn || []) rows.push({ repo: path.basename(root), run: n, role: h.role, round: h.round, file: h.file, text: a.text.replace(/\s+/g, ' ') });
  } }
fs.writeFileSync('acts.json', JSON.stringify(rows));
const by = {}; rows.forEach(r => { const k = r.repo + ' ' + r.role; by[k] = (by[k] || 0) + 1 }); console.log(by);
const kw = /authori|permission|bypass|leak|security|another (user|account|member)|someone else|data loss|lost|corrupt|double|duplicate|race|money|charge|refund|wrong (total|amount)|crash|500|silently|never (runs|fires|reaches)|false green|does not test|test passes without|vacuous/i;
rows.filter(r => r.role !== 'skeptic' && kw.test(r.text)).forEach(r => console.log(`- [${r.repo} ${r.run} ${r.role}#${r.round}] ${r.text.slice(0, 260)}`));
