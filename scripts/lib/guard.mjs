import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { loadConfig } from "./config.mjs";
import { currentLedger } from "./ledger.mjs";
import { leadDelegates } from "./size.mjs";
import { appendEvents, nextSeq, readEvents } from "./events.mjs";
import { toPosixRel } from "./paths.mjs";

// Files only the gate's own verbs may write. A model that could edit these could
// forge its evidence, so the deny is unconditional and every attempt is logged.
const EVIDENCE_FILES = new Set(["events.jsonl", "verify.json", "verify.started.json", "decisions.tsv", "ledger.json", "blocks.json", "state.json", "gate-error.log", "current-session"]);
const EVIDENCE_IN_COMMAND = /\.claude\/gate\/\S*(events\.jsonl|verify\.json|verify\.started\.json|decisions\.tsv|ledger\.json|blocks\.json|state\.json|current-session|brief-[a-z0-9-]+-\d+\.md|(?:review2?|skeptic|arbiter|worker)-\d+\.md|runs\/[^/\s]+\/base(?![\w.-]))/;
const EDIT_TOOLS = new Set(["Edit", "Write", "MultiEdit", "NotebookEdit"]);
const HELPER_ROLES = ["skeptic", "qa", "reviewer", "reviewer-2", "arbiter"];
// Shell analysis for the Bash fence. Two readers of one parse: `readsOnly` (may a command
// that names an evidence file run at all) and `shellWrites` (where does a helper's command
// write). Heredoc bodies are data, never commands; quotes make one token; `$(…)`, backticks,
// pipes, `&&`, `;` and newlines split segments, so a command hidden in a substitution is read
// like any other.
const GIT_WRITE = new Set(["add", "commit", "checkout", "switch", "reset", "restore", "stash", "apply", "am", "merge", "rebase", "mv", "rm", "clean", "push"]);
const GIT_READ = new Set(["show", "diff", "log", "status", "blame", "ls-files", "cat-file", "rev-parse"]);
// subcommands that leave HEAD and the working tree alone; any other may move them
const GIT_STILL = new Set([...GIT_READ, "ls-tree", "grep", "describe", "shortlog", "reflog", "fetch", "remote", "config", "branch", "tag"]);
const INTERPRETERS = new Set(["node", "nodejs", "deno", "bun", "python", "python3", "perl", "ruby", "php", "sh", "bash", "zsh"]);
const SHELLS = new Set(["sh", "bash", "zsh"]);
const INLINE_FLAG = /^-[a-zA-Z]*[ecpEr]$|^--eval$|^--print$/;
const INLINE_WRITE = /\b(?:writeFile(?:Sync)?|appendFile(?:Sync)?|rename(?:Sync)?|unlink(?:Sync)?|rm(?:Sync)?|rmdir(?:Sync)?|mkdir(?:Sync)?|copyFile(?:Sync)?|truncate(?:Sync)?|createWriteStream|open\s*\([^)]*["'][wa][+]?["'])|os\.(?:remove|rename|unlink|makedirs|mkdir)|shutil\.|file_put_contents|fopen|fwrite|unlink/;
const SCRATCH = /(?:^|\/)(?:tests\/\.tmp|tmp|scratchpad)(?:\/|$)|^\/private\/tmp\//;
// Programs that only read their arguments; the flags that turn one into a writer.
const READ_ONLY = new Set(["cat", "ls", "head", "tail", "grep", "egrep", "fgrep", "rg", "sed", "wc", "find", "diff", "stat", "file", "jq", "less", "more", "sort", "uniq", "cut", "tr", "column", "echo", "printf", "cd", "pwd", "test", "[", "true", "tree", "du", "date", "which", "type"]);
const WRITING_FLAG = {
  // a w command sits at the start of a script or after an address (`/x/w f`, `1w f`, `$w f`)
  // or as an s flag
  sed: /^-[a-zA-Z]*[iI]|^--in-place|(?:^|[/\d$}])[wW]\s*\S/,
  sort: /^-[a-zA-Z]*o|^--o|^--compress/,
  tree: /^-o/,
  find: /^-(?:delete|exec|execdir|ok|okdir|fprint|fls)/,
  git: /^--output/,
  rg: /^--pre/,
  perl: /^-[a-zA-Z]*i/,
};
// what each writing program writes to: every path argument, or only the last one
const WRITERS = { tee: "args", rm: "args", rmdir: "args", touch: "args", mkdir: "args", truncate: "args", mv: "args", ln: "last", cp: "last", install: "last", rsync: "last", scp: "last" };

// The heredoc bodies of a command, and the command without them.
const HEREDOC = /(<<-?\s*(['"]?)(\w+)\2[^\n]*)\n([\s\S]*?)\n[ \t]*\3(?=\n|$)/g;
export function withoutHeredocs(raw) {
  return String(raw).replace(HEREDOC, "$1");
}
function heredocBodies(raw) {
  return [...String(raw).matchAll(HEREDOC)].map((m) => m[4]).join("\n");
}

// Segments of tokens {text, quoted}. `2>&1` and `&>` stay one token; `&` alone splits.
export function segments(text) {
  const out = [];
  let seg = [];
  let tok = "";
  let has = false;
  let quoted = false;
  let quote = null;
  let resume = null; // the double quote a `$(` or backtick interrupted
  const push = () => {
    if (has) seg.push({ text: tok, quoted });
    tok = "";
    has = false;
    quoted = false;
  };
  const cut = () => {
    push();
    if (seg.length) out.push(seg);
    seg = [];
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (quote) {
      if (c === quote) quote = null;
      else if (c === "\\" && quote === '"' && i + 1 < text.length) tok += text[++i];
      else if (quote === '"' && ((c === "$" && text[i + 1] === "(") || c === "`")) {
        // a substitution runs inside double quotes too: its command is its own segment
        cut();
        resume = quote;
        quote = null;
        if (c === "$") i++;
      } else tok += c;
      continue;
    }
    if (resume && (c === ")" || c === "`")) {
      cut();
      quote = resume;
      resume = null;
      has = true;
      quoted = true;
      continue;
    }
    if (c === '"' || c === "'") {
      quote = c;
      has = true;
      quoted = true;
      continue;
    }
    if (c === "\\" && i + 1 < text.length) {
      tok += text[++i];
      has = true;
      continue;
    }
    if (c === "&") {
      if (text[i + 1] === "&") {
        cut();
        i++;
      } else if (tok.endsWith(">")) tok += c;
      else if (text[i + 1] === ">") {
        push();
        tok = "&";
        has = true;
      } else cut();
      continue;
    }
    if (c === "$" && text[i + 1] === "(") {
      cut();
      i++;
      continue;
    }
    if ("|;\n()`".includes(c)) {
      cut();
      continue;
    }
    if (/\s/.test(c)) {
      push();
      continue;
    }
    tok += c;
    has = true;
  }
  cut();
  return out;
}

// The redirect target a token opens: "" when the next token is the target, null when the
// token is no redirect or duplicates a stream (`2>&1`).
function redirect(w) {
  if (w.quoted) return null;
  const m = /^(?:\d*|&)>{1,2}(.*)$/.exec(w.text);
  if (!m || m[1].startsWith("&")) return null;
  return m[1];
}

// Path arguments of a segment: everything that is not a flag, with the token a flag consumes
// (`-e script`, `-C dir`) skipped.
function pathArgs(args, consuming = []) {
  const out = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (!a.quoted && consuming.includes(a.text)) {
      i++;
      continue;
    }
    if (!a.quoted && a.text.startsWith("-") && a.text !== "-") continue;
    if (a.text === "") continue;
    out.push(a);
  }
  return out;
}

// Leading `NAME=value` words, the rtk wrapper and shell keywords are not the program; a
// `for`/`case` header and a closing `done`/`fi` run nothing.
const KEYWORDS = new Set(["do", "then", "else", "elif", "if", "while", "until", "!", "time", "{", "}"]);
const HEADERS = new Set(["for", "case", "select", "done", "fi", "esac", "in"]);
function shift(seg) {
  const words = seg.filter((w, i) => w.text !== "" || seg.slice(0, i).some((x) => x.text !== ""));
  let pathChanged = false;
  while (words.length && !words[0].quoted && (/^[A-Za-z_]\w*=/.test(words[0].text) || words[0].text === "rtk" || KEYWORDS.has(words[0].text))) {
    if (/^PATH=/.test(words[0].text)) pathChanged = true; // a planted binary could stand in for cat
    words.shift();
  }
  if (words.length && !words[0].quoted && HEADERS.has(words[0].text)) return { words: [], pathChanged };
  return { words, pathChanged };
}

// Inline code an interpreter runs: its -e/-c argument, or its stdin when the command feeds it
// a heredoc. Null when it runs a script file, which cannot be inspected.
function inlineCode(program, args, raw) {
  if (!INTERPRETERS.has(program)) return null;
  const code = args.filter((a) => a.quoted || !a.text.startsWith("-")).map((a) => a.text);
  const flagged = args.some((a) => !a.quoted && INLINE_FLAG.test(a.text));
  const stdin = args.some((a) => a.text === "-") || (!code.length && /<</.test(raw));
  if (!flagged && !stdin) return null;
  return `${code.join("\n")}\n${stdin ? heredocBodies(raw) : ""}`;
}

// a sed script is usually quoted, so quoting does not hide a flag here
const writingFlag = (program, args) => Boolean(WRITING_FLAG[program]) && args.some((a) => WRITING_FLAG[program].test(a.text));

// Every segment starts with a read-only program, nothing is redirected to a file, and inline
// code names no write. `node …/gate.mjs` is the gate's own CLI; `sh -c` is read as a command.
export function readsOnly(raw) {
  return segments(withoutHeredocs(raw)).every((seg) => {
    const { words, pathChanged } = shift(seg);
    if (pathChanged) return false;
    for (let i = 0; i < words.length; i++) {
      const target = redirect(words[i]);
      if (target === null) continue;
      if ((target || words[i + 1]?.text || "") !== "/dev/null") return false;
    }
    if (!words.length) return true;
    const [first, ...args] = words;
    const program = first.text;
    if (program === "node" && /gate\.mjs$/.test(args[0]?.text ?? "")) return true;
    if (SHELLS.has(program) && args.some((a) => !a.quoted && /^-[a-zA-Z]*c/.test(a.text))) return readsOnly(args.filter((a) => a.quoted).map((a) => a.text).join("\n"));
    const code = inlineCode(program, args, raw);
    if (code !== null) return !INLINE_WRITE.test(code) && !writingFlag(program, args);
    if (writingFlag(program, args)) return false;
    if (program === "git") return GIT_READ.has(args[0]?.text === "-C" ? args[2]?.text : args[0]?.text);
    return READ_ONLY.has(program);
  });
}

// Whether a command may have moved HEAD or the tree through git: it is not read-only and its text
// names git with a subcommand outside the still ones, behind any wrapper. Errs toward yes.
const GIT_CALL = /(?:^|[^\w.-])git(?:\s+(?:-[Cc]\s+\S+|-\S+))*\s+([a-z][\w-]*)(\s+list\b)?/g;
export function gitWrites(raw) {
  if (readsOnly(raw)) return false;
  return [...String(raw).matchAll(GIT_CALL)].some((m) => !GIT_STILL.has(m[1]) && !(m[2] && (m[1] === "stash" || m[1] === "worktree")));
}

// Inline code that writes, wherever its target: a heredoc body is text to the shell but code
// to the interpreter it feeds.
export function inlineWrites(raw) {
  return segments(withoutHeredocs(raw)).some((seg) => {
    const { words } = shift(seg);
    if (!words.length) return false;
    const code = inlineCode(words[0].text, words.slice(1), raw);
    return code !== null && INLINE_WRITE.test(code);
  });
}

// Where a command writes: `outside` lists the targets not under a scratch path; `blind` names
// writes whose target cannot be read from the text (an unknown variable, inline code that
// writes, a git command, an extract into an unknown directory). Variables set in the same
// command and `cd` are followed, so `S=/tmp/x; echo > $S/a` and `cd tests/.tmp && cp a ./b`
// resolve.
export function shellWrites(raw) {
  const vars = {};
  let cwd = "";
  let cwdKnown = true;
  const outside = [];
  const blind = [];
  const expand = (t) => t.replace(/\$\{(\w+)\}|\$(\w+)/g, (m, a, b) => vars[a ?? b] ?? m);
  const resolve = (t) => {
    const x = expand(t);
    if (/\$|^~/.test(x)) return null;
    if (x.startsWith("/")) return x;
    return cwdKnown ? (cwd ? `${cwd}/${x}` : x) : null;
  };
  const target = (t, what) => {
    if (/^\/dev\/(?:null|stderr|stdout)$/.test(t)) return;
    const r = resolve(t);
    if (r === null) blind.push(`${what} ${t} (unknown location)`);
    else if (!SCRATCH.test(r)) outside.push(r);
  };
  const walk = (text) => {
    for (const seg of segments(withoutHeredocs(text))) {
      const words = [];
      for (const w of seg) {
        const assign = !words.length && !w.quoted ? /^([A-Za-z_]\w*)=(.*)$/.exec(w.text) : null;
        if (assign) {
          vars[assign[1]] = expand(assign[2]);
          continue;
        }
        if (!words.length && !w.quoted && (w.text === "rtk" || KEYWORDS.has(w.text))) continue;
        if (!words.length && !w.quoted && HEADERS.has(w.text)) break;
        words.push(w);
      }
      const rest = [];
      for (let i = 0; i < words.length; i++) {
        const t = redirect(words[i]);
        if (t === null) {
          rest.push(words[i]);
          continue;
        }
        const to = t || words[++i]?.text;
        if (to !== undefined) target(to, "redirect to");
      }
      if (!rest.length) continue;
      const [first, ...args] = rest;
      const program = first.text;
      const flag = (re) => args.some((a) => !a.quoted && re.test(a.text));
      if (program === "cd") {
        const r = args[0] ? resolve(args[0].text) : null;
        cwdKnown = r !== null;
        cwd = r ?? "";
        continue;
      }
      if (program === "git") {
        const verb = args[0]?.text === "-C" ? args[2]?.text : args[0]?.text;
        if (GIT_WRITE.has(verb)) blind.push(`git ${verb} changes the repo`);
        continue;
      }
      if (program === "xargs") {
        const next = pathArgs(args)[0]?.text;
        if (next && (WRITERS[next] || ["sed", "perl", "git", "tar", "dd"].includes(next))) blind.push(`xargs ${next} writes where its input says`);
        continue;
      }
      if (SHELLS.has(program) && flag(/^-[a-zA-Z]*c/)) {
        for (const a of args) if (a.quoted) walk(a.text);
        continue;
      }
      const code = inlineCode(program, args, text);
      if (code !== null && INLINE_WRITE.test(code)) blind.push(`${program} inline code writes`);
      if (program === "perl" && flag(WRITING_FLAG.perl)) for (const a of pathArgs(args, ["-e", "-E"])) target(a.text, "perl -i on");
      if (program === "sed" && flag(/^-[a-zA-Z]*[iI]|^--in-place/)) {
        const files = pathArgs(args, ["-e", "-f", "--expression", "--file"]);
        for (const a of flag(/^-[ef]$|^--expression|^--file/) ? files : files.slice(1)) target(a.text, "sed -i on");
      }
      if (program === "sed" && args.some((a) => /(?:^|[/\d$}])[wW]\s*\S/.test(a.text))) blind.push("sed w writes a file named in its script");
      if (program === "dd") for (const a of args) if (/^of=/.test(a.text)) target(a.text.slice(3), "dd of=");
      if (program === "tar" && (flag(/^-[a-zA-Z]*x|^--extract/) || /^[a-z]*x/.test(args[0]?.text ?? ""))) {
        const c = args.findIndex((a) => a.text === "-C");
        if (c >= 0 && args[c + 1]) target(args[c + 1].text, "tar -C");
        else if (cwdKnown) target(cwd || ".", "tar extracts into");
        else blind.push("tar extracts into an unknown directory");
      }
      if ((program === "sort" || program === "tree") && flag(/^-[a-zA-Z]*o/)) {
        const i = args.findIndex((a) => !a.quoted && /^-[a-zA-Z]*o/.test(a.text));
        const glued = args[i].text.replace(/^-[a-zA-Z]*o/, "");
        target(glued || args[i + 1]?.text || "", `${program} -o`);
      }
      if (program === "find") {
        if (flag(/^-(?:exec|execdir|ok|okdir)$/)) blind.push("find -exec runs a command per file");
        if (flag(/^-delete$/)) for (const a of pathArgs(args)) target(a.text, "find -delete under");
        const fp = args.findIndex((a) => /^-(?:fprint|fls)$/.test(a.text));
        if (fp >= 0 && args[fp + 1]) target(args[fp + 1].text, "find -fprint");
      }
      const mode = WRITERS[program];
      if (!mode) continue;
      const paths = pathArgs(args);
      for (const a of mode === "last" ? paths.slice(-1) : paths) target(a.text, program);
    }
  };
  walk(raw);
  return { outside, blind };
}

function targetPaths(input, root) {
  const ti = input.tool_input ?? {};
  const raw = input.tool_name === "MultiEdit" ? (ti.edits ?? []).map((e) => e?.file_path) : [ti.file_path ?? ti.notebook_path];
  return raw.map((p) => toPosixRel(root, p)).filter((p) => typeof p === "string" && p.length);
}

const PACKET = /^\.claude\/gate\/runs\/[^/]+\/brief-[a-z0-9-]+-\d+\.md$/;
// the copies `gate open` took of files already modified then: what the task's diff starts from
const BASE_COPY = /^\.claude\/gate\/runs\/[^/]+\/base(?![\w.-])/;

function isEvidence(rel) {
  if (!rel.startsWith(".claude/gate/")) return false;
  if (rel.startsWith(".claude/gate/sessions/")) return true;
  if (PACKET.test(rel)) return true; // a helper's packet is written by `gate brief` only
  if (BASE_COPY.test(rel)) return true;
  return EVIDENCE_FILES.has(rel.split("/").pop());
}

function isReviewFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/review-\d+\.md$/.test(rel);
}

function isReview2File(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/review2-\d+\.md$/.test(rel);
}

function isSkepticFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/skeptic-\d+\.md$/.test(rel);
}

function isArbiterFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/arbiter-\d+\.md$/.test(rel);
}

function isWorkerFile(rel) {
  return /^\.claude\/gate\/runs\/[^/]+\/worker-\d+\.md$/.test(rel);
}

// A helper's own file must land in the run it was spawned for, never another task's folder.
// With no open ledger there is no task, so there is nowhere a helper may write.
function inCurrentRun(rel, current) {
  return Boolean(current) && rel.startsWith(`${current}/`);
}

// A reading helper (skeptic, reviewer, arbiter) owes a draft while a packet for its role has
// no file and it has written none itself (its Write of a draft is an edit event under its
// agent id). Until then it may only read its packet and write one of the owed files, so a
// helper that runs out of turns always leaves a file; two reviewers out at once each owe
// their own number.
const OWN_FILE = { skeptic: "skeptic", reviewer: "review", "reviewer-2": "review2", arbiter: "arbiter" };
function draftOwed(roleName, root, currentRun, { stateDir, session, agentId } = {}) {
  const prefix = OWN_FILE[roleName];
  if (!prefix || !currentRun) return null;
  const dir = path.join(root, currentRun);
  if (!existsSync(dir)) return null;
  const names = readdirSync(dir);
  const number = (f) => Number(/-(\d+)\.md$/.exec(f)[1]);
  const packets = names.filter((f) => new RegExp(`^brief-${roleName}-\\d+\\.md$`).test(f)).map(number);
  const files = names.filter((f) => new RegExp(`^${prefix}-\\d+\\.md$`).test(f)).map(number);
  const owed = packets.filter((n) => !files.includes(n));
  if (!owed.length) return null;
  const own = new RegExp(`^${currentRun}/${prefix}-\\d+\\.md$`);
  if (agentId && stateDir && readEvents(stateDir, session).some((e) => e.kind === "edit" && e.agent === agentId && own.test(e.path ?? ""))) return null;
  return owed.sort((a, b) => a - b).map((n) => `${currentRun}/${prefix}-${n}.md`);
}

export function decide(input, root, config = loadConfig(root), currentRun = null, ledger = null, where = {}) {
  const tool = input.tool_name ?? "";
  const agentType = input.agent_type ?? null;
  const roleName = Object.keys(OWN_FILE).find((r) => agentType === `done-gate:${r}` || agentType === r) ?? null;
  const owed = roleName ? draftOwed(roleName, root, currentRun, { ...where, agentId: input.agent_id ?? null }) : null;
  if (owed) {
    const rel = targetPaths(input, root)[0] ?? null;
    const packet = rel && PACKET.test(rel);
    const ownFile = owed.includes(rel);
    if (!((tool === "Read" && packet) || (EDIT_TOOLS.has(tool) && ownFile))) {
      return { deny: true, reason: `done-gate: write your draft first: ${owed.join(" or ")} (every section may read "- unverified"); until it exists you may only read your packet. Then investigate and rewrite it.`, paths: rel ? [rel] : [] };
    }
    return { deny: false };
  }
  if (tool === "Read") return { deny: false };

  if (tool === "Bash") {
    const cmd = String(input.tool_input?.command ?? "");
    // a heredoc that quotes an evidence path is text; the command around it is what runs,
    // unless the heredoc feeds an interpreter whose code writes
    if ((EVIDENCE_IN_COMMAND.test(withoutHeredocs(cmd)) && !readsOnly(cmd)) || (EVIDENCE_IN_COMMAND.test(cmd) && inlineWrites(cmd))) {
      return { deny: true, reason: "done-gate: that command writes gate evidence files (.claude/gate/...). Evidence is written only by `gate` verbs; read it with cat, grep or `gate report`.", paths: [] };
    }
    // Helpers write only through the edit tools, where the role rules apply; a shell write
    // would bypass them, so their shell writes stay under scratch paths.
    if (HELPER_ROLES.some((r) => agentType === `done-gate:${r}` || agentType === r)) {
      const { outside, blind } = shellWrites(cmd);
      if (outside.length || blind.length) {
        const what = [...outside.map((p) => `writes ${p}`), ...blind].slice(0, 3).join("; ");
        return { deny: true, reason: `done-gate: helpers write through the shell only under scratch paths (tests/.tmp, /tmp, a scratchpad) and never with git write commands; this command ${what}. Reading, grep, the test command and read-only inline code are fine; use the Write tool for your own file, or report what should change.`, paths: [] };
      }
    }
    return { deny: false };
  }
  if (!EDIT_TOOLS.has(tool)) return { deny: false };

  const paths = targetPaths(input, root);
  for (const rel of paths) {
    if (isEvidence(rel)) {
      return { deny: true, reason: `done-gate: ${rel} is gate evidence and is written only by \`gate\` verbs.`, paths };
    }
  }
  const role = (r) => agentType === `done-gate:${r}` || agentType === r;
  // at a delegated size (policy.delegatesAt, large by default) source and tests belong to the
  // worker and QA, and so does any other agent the lead might spawn instead of a worker. A "delegate"
  // waiver (R16 honours the same key) lifts this fence too.
  const delegateWaived = Boolean(ledger) && (ledger.waivers ?? []).some((w) => w.key === "delegate");
  const size = !role("worker") && !role("qa") && ledger && !delegateWaived ? leadDelegates(ledger) : null;
  if (size) {
    const owned = paths.filter((p) => config.isSource(p));
    if (owned.length) {
      const who = agentType === null ? "the lead does not edit source" : `${agentType} is not a worker`;
      return { deny: true, delegate: true, reason: `done-gate: size ${size}: ${who}; ${owned.join(", ")} belongs to a worker. Run \`gate brief worker\` and spawn done-gate:worker with the prompt it prints (or re-plan with \`gate note plan --files\` if this is really one small file).`, paths };
    }
  }
  if (role("skeptic")) {
    const outside = paths.filter((p) => !isSkepticFile(p) || !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the skeptic writes only its own skeptic-<n>.md in the run dir; ${outside.join(", ")} is not that. Put findings in that file and reply with the Act-on list.`, paths };
    }
    return { deny: false };
  }
  if (role("arbiter")) {
    const outside = paths.filter((p) => !isArbiterFile(p) || !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the arbiter writes only its own arbiter-<n>.md in the run dir; ${outside.join(", ")} is not that.`, paths };
    }
    return { deny: false };
  }
  // a helper's file is its evidence: nobody else writes it
  const foreign = paths.filter((p) => isSkepticFile(p) || isArbiterFile(p) || (isReviewFile(p) && !role("reviewer")) || (isReview2File(p) && !role("reviewer-2")) || (isWorkerFile(p) && !role("worker")));
  if (foreign.length) {
    return { deny: true, reason: `done-gate: ${foreign.join(", ")} is a helper's own evidence file and is written only by that helper.`, paths };
  }
  if (role("qa")) {
    const outside = paths.filter((p) => !config.isTest(p));
    if (outside.length) {
      return { deny: true, reason: `done-gate: QA may write only under the tests globs; ${outside.join(", ")} is outside them. Report what the implementation should change instead.`, paths };
    }
  }
  if (role("worker")) {
    const outside = paths.filter((p) => isWorkerFile(p) && !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the worker writes its worker-<n>.md only in the current run dir; ${outside.join(", ")} is not that.`, paths };
    }
  }
  if (role("reviewer") || role("reviewer-2")) {
    const own = role("reviewer") ? isReviewFile : isReview2File;
    const outside = paths.filter((p) => !own(p) || !inCurrentRun(p, currentRun));
    if (outside.length) {
      return { deny: true, reason: `done-gate: the reviewer writes only its own ${OWN_FILE[role("reviewer") ? "reviewer" : "reviewer-2"]}-<n>.md in the run dir; ${outside.join(", ")} is not that. Report findings, do not fix.`, paths };
    }
  }
  return { deny: false };
}

export const verbs = {
  fence(ctx) {
    let currentRun = null;
    let ledger = null;
    try {
      const current = currentLedger(ctx.stateDir, ctx.session);
      if (current) {
        currentRun = path.relative(ctx.root, current.dir).split(path.sep).join("/");
        ledger = current.ledger;
      }
    } catch {
      // unreadable state: fall back to the role rules alone
    }
    const verdict = decide(ctx.input, ctx.root, undefined, currentRun, ledger, { stateDir: ctx.stateDir, session: ctx.session });
    if (!verdict.deny) return;
    appendEvents(ctx.stateDir, ctx.session, [
      {
        seq: nextSeq(),
        ts: new Date().toISOString(),
        session: ctx.session,
        agent: ctx.input?.agent_id ?? null,
        agentType: ctx.input?.agent_type ?? null,
        kind: "deny",
        delegate: verdict.delegate === true,
        tool: ctx.input?.tool_name ?? null,
        path: verdict.paths?.[0] ?? null,
        ...(ctx.input?.tool_name === "Bash" ? { cmd: String(ctx.input.tool_input?.command ?? "").slice(0, 200) } : {}),
        reason: verdict.reason,
      },
    ]);
    ctx.out({
      hookSpecificOutput: {
        hookEventName: "PreToolUse",
        permissionDecision: "deny",
        permissionDecisionReason: verdict.reason,
      },
    });
  },
};
