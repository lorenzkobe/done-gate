// Readers for the files helpers write: a reviewer's or skeptic's findings, a reviewer's
// answers to disputes, and an arbiter's ruling. Bullets only; prose is ignored.

function sectionLines(text, heading) {
  const re = new RegExp(`^## ${heading}\\s*$`, "m");
  const m = re.exec(String(text ?? "").replace(/\r/g, ""));
  if (!m) return [];
  const rest = text.slice(m.index + m[0].length);
  const end = /^## /m.exec(rest);
  return (end ? rest.slice(0, end.index) : rest).split("\n");
}

function bullets(lines) {
  const out = [];
  for (const raw of lines) {
    const m = /^\s*[-*]\s+(.*\S)\s*$/.exec(raw);
    if (!m) continue;
    if (/^(?:none|n\/a|nothing)\.?$/i.test(m[1].trim())) continue;
    out.push(m[1].trim());
  }
  return out;
}

// Every Act-on bullet of a helper file. "none" and a missing section are empty.
export function parseFindings(text) {
  return bullets(sectionLines(text, "Act on")).map((t) => ({ text: t }));
}

const VERDICT = /^(H\d+\.\d+)\s*[—–-]+\s*(withdrawn|upheld)\s*:\s*(.*)$/i;

// A reviewer's answers to disputed items: `- H1.2 — withdrawn: reason` / `upheld: reason`.
export function parseDisputes(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Disputes"))) {
    const m = VERDICT.exec(b);
    if (m) out.push({ id: m[1], verdict: m[2].toLowerCase(), reason: m[3].trim() });
  }
  return out;
}

const RULING = /^(H\d+\.\d+)\s*[—–-]+\s*(implementer|reviewer)\s*:\s*(.*)$/i;

// An arbiter's ruling: `- H1.2 — implementer: reason` / `reviewer: reason`.
export function parseRuling(text) {
  const out = [];
  for (const b of bullets(sectionLines(text, "Ruling"))) {
    const m = RULING.exec(b);
    if (m) out.push({ id: m[1], side: m[2].toLowerCase(), reason: m[3].trim() });
  }
  return out;
}
