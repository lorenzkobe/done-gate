import fs from 'fs'; import path from 'path';
const [from, to, ...roots] = process.argv.slice(2);
for (const root of roots) {
  const sd = path.join(root, '.claude/gate/sessions');
  const agg = { sessions: 0, blocks: {}, denies: [], verbs: {}, pgrep: 0, testMin: 0, testCmds: 0, over9min: 0, verifyMin: 0, verifyN: 0, prompts: 0, agents: {}, slow: [] };
  for (const s of fs.readdirSync(sd)) {
    const f = path.join(sd, s, 'events.jsonl'); if (!fs.existsSync(f)) continue;
    const L = fs.readFileSync(f, 'utf8').trim().split('\n').filter(Boolean).map(l => { try { return JSON.parse(l) } catch { return null } }).filter(e => e && e.ts >= from && e.ts < to);
    if (!L.length) continue; agg.sessions++;
    const start = {}; for (const e of L) if (e.kind === 'command-start') start[e.toolUseId] = Date.parse(e.ts);
    for (const e of L) {
      if (e.kind === 'prompt') agg.prompts++;
      if (e.kind === 'block') for (const r of e.rules || []) agg.blocks[r] = (agg.blocks[r] || 0) + 1;
      if (e.kind === 'deny') agg.denies.push(((e.agentType || 'lead') + ' ' + (e.path || '') + ' :: ' + (e.cmd || e.reason || '')).slice(0, 220));
      if (e.kind === 'agent') agg.agents[e.spawned] = (agg.agents[e.spawned] || 0) + 1;
      if (e.kind !== 'command' || !e.cmd) continue;
      const m = e.cmd.match(/\bgate (\w+)(?: (--final|--step|\w+))?/g);
      if (m) for (const v of m) { const k = v.replace(/^gate /, ''); const kk = /^(verify|test|setup|waive|step|note|open|close|rebaseline|abandon|case)\b/.test(k) ? k.split(' ').slice(0, k.startsWith('verify') || k.startsWith('setup') ? 2 : 1).join(' ') : k.split(' ')[0]; agg.verbs[kk] = (agg.verbs[kk] || 0) + 1; }
      if (/pgrep/.test(e.cmd)) agg.pgrep++;
      const d = start[e.toolUseId] ? (Date.parse(e.ts) - start[e.toolUseId]) / 60000 : null;
      const isTest = /pytest|test_db\.sh|vitest|npm (run )?test|manage\.py test/.test(e.cmd) && !/gate verify/.test(e.cmd);
      if (d != null && isTest) { agg.testMin += d; agg.testCmds++; if (d > 9.5) agg.over9min++; }
      if (d != null && /gate verify/.test(e.cmd)) { agg.verifyMin += d; agg.verifyN++; }
      if (d != null && d > 9.5) agg.slow.push(`${(e.agentType || 'lead')} ${d.toFixed(1)}m ${e.cmd.slice(0, 140)}`);
    }
  }
  agg.testMin = Math.round(agg.testMin); agg.verifyMin = Math.round(agg.verifyMin);
  agg.denyCount = agg.denies.length;
  console.log('== ' + path.basename(root), from, '->', to);
  console.log(JSON.stringify({ ...agg, denies: agg.denies.slice(0, 40), slow: agg.slow.slice(0, 25) }, null, 1));
}
