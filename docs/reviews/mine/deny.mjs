import fs from 'fs'; import path from 'path';
const [from, ...roots] = process.argv.slice(2);
for (const root of roots) {
  const sd = path.join(root, '.claude/gate/sessions'); const c = {}; const ex = {};
  for (const s of fs.readdirSync(sd)) {
    const f = path.join(sd, s, 'events.jsonl'); if (!fs.existsSync(f)) continue;
    for (const l of fs.readFileSync(f, 'utf8').split('\n')) { if (!l.includes('"deny"')) continue; let e; try { e = JSON.parse(l) } catch { continue }
      if (e.kind !== 'deny' || e.ts < from) continue;
      const cmd = e.cmd || ''; let k;
      if (/(review2?|skeptic|worker|arbiter|qa)-\d+\.md/.test(cmd) && /sed -i|python|cat >|printf|>>/.test(cmd)) k = 'helper edits its own findings file';
      else if (/verify\.json|ledger\.json|events\.jsonl|brief-/.test(cmd) && !/sed -i|>/.test(cmd.replace(/2>&1|>\/dev\/null/g,''))) k = 'read-only look at an evidence file';
      else if (/\.claude\/gate\/runs/.test(cmd) && /(grep|ls|head|cat|sed -n)/.test(cmd) && !/sed -i|cat >/.test(cmd)) k = 'read-only look in run folder';
      else if (/gate\.json/.test(e.path || cmd)) k = 'edit gate.json';
      else if (e.path && /size large/.test(cmd)) k = 'lead edits source at large';
      else if (e.agentType === 'done-gate:qa' || e.agentType === 'done-gate:worker') k = e.agentType + ' source/test edit refused';
      else if (!e.agentType) k = 'lead source edit before plan/fence';
      else k = 'other ' + e.agentType;
      c[k] = (c[k] || 0) + 1; (ex[k] ||= []).push(cmd.slice(0, 150).replace(/\n/g, ' '));
    } }
  console.log('==', path.basename(root)); for (const [k, v] of Object.entries(c).sort((a, b) => b[1] - a[1])) console.log(' ', v, k, '| e.g.', ex[k][0]);
}
