import { assess } from "./assess.mjs";

// Prints only what is still unmet; "clean" when nothing is. The run dir and the change
// count are one `gate doctor` away and were noise on every call.
export const verbs = {
  check(ctx) {
    const { unmet } = assess(ctx, {});
    if (unmet.length === 0) {
      ctx.out("clean");
      return;
    }
    unmet.forEach((u, i) => ctx.out(`${i + 1}. ${u.rule} — ${u.text}`));
  },
};
