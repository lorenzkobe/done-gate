import { assess } from "./assess.mjs";

export const verbs = {
  check(ctx) {
    const { state, unmet } = assess(ctx, {});
    const src = state.changed.filter((p) => state.config.isSource(p));
    ctx.out(`ledger: ${state.dir ?? "(none open for this session)"}`);
    ctx.out(`changed since baseline: ${state.changed.length} file(s), ${src.length} source`);
    if (unmet.length === 0) {
      ctx.out("unmet: none — the gate would allow the turn to end.");
      return;
    }
    ctx.out(`unmet: ${unmet.length}`);
    unmet.forEach((u, i) => ctx.out(`${i + 1}. ${u.rule} — ${u.text}`));
  },
};
