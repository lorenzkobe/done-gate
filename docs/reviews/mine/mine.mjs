import fs from 'fs'; import path from 'path';
const roots = process.argv.slice(2);
const out = [];
for (const root of roots) {
  const rd = path.join(root, '.claude/gate/runs');
  if (!fs.existsSync(rd)) continue;
  for (const name of fs.readdirSync(rd)) {
    const lf = path.join(rd, name, 'ledger.json');
    if (!fs.existsSync(lf)) continue;
    let l; try { l = JSON.parse(fs.readFileSync(lf, 'utf8')); } catch (e) { out.push({repo: path.basename(root), name, err: String(e)}); continue; }
    const files = fs.readdirSync(path.join(rd, name));
    const steps = l.steps || [];
    const st = {}; for (const s of steps) st[s.state] = (st[s.state] || 0) + 1;
    const huddles = l.huddles || [];
    const byRole = {}; let actOn = 0, actOpen = 0;
    for (const h of huddles) { byRole[h.role] = (byRole[h.role] || 0) + 1; for (const a of h.actOn || []) { actOn++; if (!a.closed) actOpen++; } }
    const dur = l.closedAt && l.openedAt ? (Date.parse(l.closedAt) - Date.parse(l.openedAt)) / 60000 : null;
    out.push({
      repo: path.basename(root), name, version: l.version, playbook: l.playbook, status: l.status,
      openedAt: l.openedAt, closedAt: l.closedAt, wallMin: dur && Math.round(dur),
      predicted: l.tier?.predicted, declared: l.tier?.declared, measured: l.tier?.measured?.tier,
      mFiles: l.tier?.measured?.files, mLines: l.tier?.measured?.lines,
      cases: (l.cases || []).length, steps: st,
      waived: steps.filter(s => s.state === 'WAIVED').map(s => s.key + ': ' + (s.note || '').slice(0, 160)),
      skipped: steps.filter(s => s.state === 'SKIPPED').map(s => s.key + ': ' + (s.note || '').slice(0, 160)),
      waivers: (l.waivers || []).map(w => (w.rule || w.key || '') + ': ' + (w.reason || w.note || JSON.stringify(w)).slice(0, 200)),
      pauses: (l.pauses || []).length, rebaselines: (l.rebaselines || []).map(r => (r.reason || '').slice(0, 160)),
      huddles: byRole, actOn, actOpen,
      reviewFiles: files.filter(f => /^review2?-\d+\.md$/.test(f)).length,
      fixcheck: files.filter(f => /fix/i.test(f)).length,
      workers: files.filter(f => /^worker-/.test(f)).length,
      qa: files.filter(f => /^qa/.test(f)).length,
      arbiter: files.filter(f => /^arbiter/.test(f)).length,
      verifyAdded: (l.verifyAdded || []).length, verifyDropped: (l.verifyDropped || []).length,
      sessions: (l.sessions || []).length, caveats: (l.caveats || []).length,
      keys: Object.keys(l),
    });
  }
}
console.log(JSON.stringify(out));
