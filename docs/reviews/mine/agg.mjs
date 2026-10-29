import fs from 'fs';
const r = JSON.parse(fs.readFileSync('runs.json'));
const med = a => { a = a.filter(x => x != null).sort((x, y) => x - y); return a.length ? a[Math.floor(a.length / 2)] : null; };
const sum = a => a.reduce((x, y) => x + y, 0);
function summarize(label, xs) {
  const c = k => { const o = {}; xs.forEach(x => o[x[k]] = (o[x[k]] || 0) + 1); return o; };
  const large = xs.filter(x => x.measured === 'large' || x.declared === 'large');
  const sizeMatch = xs.filter(x => x.predicted && x.measured);
  console.log(`\n== ${label}: ${xs.length} runs`);
  console.log(' status', c('status'), ' playbook', c('playbook'));
  console.log(' measured', c('measured'), ' predicted', c('predicted'));
  console.log(' size predicted==measured', sizeMatch.filter(x => x.predicted === x.measured).length, '/', sizeMatch.length,
    ' under-predicted', sizeMatch.filter(x => ['tiny','small','standard','large'].indexOf(x.predicted) < ['tiny','small','standard','large'].indexOf(x.measured)).length);
  console.log(' wall min median', med(xs.map(x => x.wallMin)), ' large median', med(large.map(x => x.wallMin)), ' large n', large.length);
  console.log(' review files total', sum(xs.map(x => x.reviewFiles)), ' median/run', med(xs.map(x => x.reviewFiles)), ' large median', med(large.map(x => x.reviewFiles)));
  console.log(' skeptic huddles', sum(xs.map(x => x.huddles.skeptic || 0)), ' actOn total', sum(xs.map(x => x.actOn)), ' actOpen', sum(xs.map(x => x.actOpen)));
  console.log(' runs with waivers', xs.filter(x => x.waivers.length).length, ' waived steps', sum(xs.map(x => x.waived.length)), ' skipped steps', sum(xs.map(x => x.skipped.length)));
  console.log(' rebaselines', sum(xs.map(x => x.rebaselines.length)), ' pauses', sum(xs.map(x => x.pauses)), ' multi-session runs', xs.filter(x => x.sessions > 1).length);
  console.log(' workers files', sum(xs.map(x => x.workers)), ' qa', sum(xs.map(x => x.qa)), ' arbiter', sum(xs.map(x => x.arbiter)));
  console.log(' verifyAdded runs', xs.filter(x => x.verifyAdded).length, ' verifyDropped runs', xs.filter(x => x.verifyDropped).length);
}
const v20 = r.filter(x => x.version === '0.20.0');
for (const repo of [...new Set(v20.map(x => x.repo))]) summarize('0.20 ' + repo, v20.filter(x => x.repo === repo));
summarize('0.20 all', v20);
summarize('rollcall 0.19.0', r.filter(x => x.repo === 'rollcall' && x.version === '0.19.0'));
summarize('rollcall 0.17.1', r.filter(x => x.repo === 'rollcall' && x.version === '0.17.1'));
summarize('rollcall 0.16.0', r.filter(x => x.repo === 'rollcall' && x.version === '0.16.0'));
