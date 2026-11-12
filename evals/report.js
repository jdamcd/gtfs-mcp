#!/usr/bin/env node
// Writes the summary as an HTML page beside the results file. The terminal
// gets a few short lines and a link, since the tables don't fit a narrow one.
//
// Usage: node evals/report.js evals/results/latest.json

import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { summarize } from "./summarize.js";
import { describeExpectations } from "./tool-calls.js";

const pct = (x) => `${(x * 100).toFixed(1)}%`;
const count = (n) => n.toLocaleString("en-US");
const plural = (n, word) => `${n} ${word}${n === 1 ? "" : "s"}`;
const mean = (x) => (Number.isInteger(x) ? String(x) : x.toFixed(1));

const ENTITIES = { "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" };
const esc = (s) => String(s).replace(/[&<>"']/g, (c) => ENTITIES[c]);

const range = ([lo, hi]) => `${pct(lo)} to ${pct(hi)}`;

const MARKS = { critical: "✕", warning: "!" };
const FLAGS = {
  failed: { level: "critical", meaning: "Failed every run" },
  inconsistent: { level: "warning", meaning: "Passed some runs" },
};
const badge = (level, meaning) =>
  `<span class="badge ${level}" role="img" aria-label="${meaning}" title="${meaning}">${MARKS[level]}</span>`;
const legendKey = (level, text) =>
  `<span class="key"><span class="badge ${level}" aria-hidden="true">${MARKS[level]}</span>${text}</span>`;

function tableSection({ title, tableClass, head, rows, foot = "", note }) {
  return `
  <section>
    <h2>${title}</h2>
    <div class="scroll">
      <table${tableClass ? ` class="${tableClass}"` : ""}>
        <thead>${head}
        </thead>
        <tbody>${rows.join("")}
        </tbody>${foot}
      </table>
    </div>
    <p class="note">${note}</p>
  </section>`;
}

export function renderText(summary) {
  const width = Math.max(0, ...summary.models.map((m) => m.label.length));
  const lines = summary.models.map((m) => {
    const result = m.graded ? `${m.passes}/${m.graded} passed (${pct(m.rate)})` : "no graded runs";
    return `${m.label.padEnd(width)}  ${result}${m.errors ? `, ${m.errors} errored` : ""}`;
  });
  for (const c of summary.cases) {
    for (const [label, r] of Object.entries(c.results)) {
      if (r.status === "failed") lines.push(`Failed every run: ${c.desc} (${label})`);
      if (r.status === "inconsistent") {
        lines.push(`Inconsistent: ${c.desc} (${label}, ${r.passes}/${r.graded})`);
      }
    }
  }
  lines.push(`Estimated cost: $${summary.totalCost.toFixed(2)}`);
  return lines.join("\n");
}

function intro(summary) {
  const { run, models, cases } = summary;
  const graded = models.reduce((sum, m) => sum + m.graded, 0);
  const passes = models.reduce((sum, m) => sum + m.passes, 0);
  const errors = models.reduce((sum, m) => sum + m.errors, 0);
  const date = run.timestamp ? new Date(run.timestamp) : null;
  const when =
    date && !Number.isNaN(date.getTime())
      ? ` ${esc(date.toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" }))}`
      : "";
  const tool = run.promptfooVersion ? ` with promptfoo ${esc(run.promptfooVersion)}` : "";
  const lede =
    `${passes} of ${plural(graded, "graded run")} passed.` +
    (errors ? ` ${plural(errors, "run")} hit a provider error and ${errors === 1 ? "isn't" : "aren't"} graded.` : "");
  return `
  <header>
    <h1>${esc(run.title)}</h1>
    <p class="lede">${lede}</p>
    <p class="note">Run${when}${tool}. ${plural(cases.length, "case")} on ${plural(models.length, "model")}, ${plural(run.repeats, "run")} each.</p>
  </header>`;
}

function strip(m) {
  if (m.rate === null) return "";
  const [lo, hi] = m.interval;
  const label = `${pct(m.rate)} passed, 95% interval ${range(m.interval)}`;
  return `<div class="strip" role="img" aria-label="${label}" title="${label}"><i class="interval" style="left:${pct(lo)};width:${pct(hi - lo)}"></i><i class="rate" style="left:${pct(m.rate)}"></i></div>`;
}

function passRates(models) {
  const rows = models.map(
    (m) => `
        <tr>
          <th scope="row">${esc(m.label)}</th>
          <td class="num wide">${m.passes}/${m.graded}</td>
          <td class="num">${m.rate === null ? "–" : pct(m.rate)}</td>
          <td class="num">${m.interval ? range(m.interval) : "–"}</td>
          <td class="plot">${strip(m)}</td>
        </tr>`,
  );
  return tableSection({
    title: "Pass rate by model",
    head: `
          <tr>
            <th scope="col">Model</th>
            <th scope="col" class="num wide">Passed</th>
            <th scope="col" class="num">Pass rate</th>
            <th scope="col" class="num">95% interval</th>
            <th scope="col" class="plot"><span class="sr">Pass rate and interval from 0 to 100%</span><div class="scale" aria-hidden="true"><span style="left:0">0%</span><span style="left:50%">50%</span><span style="left:100%">100%</span></div></th>
          </tr>`,
    rows,
    note: "The ring marks the pass rate and the bar its 95% confidence interval. Where two models' bars overlap, this run doesn't show a real difference between them.",
  });
}

function caseCell(r) {
  if (!r) return `<td>–</td>`;
  const flag = FLAGS[r.status];
  const mark = flag ? badge(flag.level, flag.meaning) : "";
  const score = r.graded ? `${r.passes}/${r.graded}` : "–";
  const calls = r.callsPerRun === null ? "" : `<span class="aside">${mean(r.callsPerRun)} ${r.callsPerRun === 1 ? "call" : "calls"}</span>`;
  const errors = r.errors ? `<span class="aside">${r.errors} errored</span>` : "";
  return `<td${flag ? ` class="${flag.level}"` : ""}><div class="cell"><span class="mark">${mark}</span><div class="stack"><span class="score">${score}</span>${calls}${errors}</div></div></td>`;
}

function caseName(c) {
  const checks = describeExpectations(c.spec);
  if (!c.query && !checks.length) return esc(c.desc);
  const query = c.query ? `<div class="aside">Query</div><p>${esc(c.query)}</p>` : "";
  const passes = checks.length
    ? `<div class="aside">Passes when the model</div><ul>${checks.map((line) => `<li>${esc(line)}</li>`).join("")}</ul>`
    : "";
  return `<details><summary>${esc(c.desc)}</summary><div class="about">${query}${passes}</div></details>`;
}

function caseTable(summary) {
  const labels = summary.models.map((m) => m.label);
  const rows = summary.cases.map(
    (c) => `
        <tr>
          <th scope="row">${caseName(c)}</th>${labels.map((label) => caseCell(c.results[label])).join("")}
        </tr>`,
  );
  const seen = new Set(summary.cases.flatMap((c) => Object.values(c.results).map((r) => r.status)));
  const legend = Object.entries(FLAGS)
    .filter(([status]) => seen.has(status))
    .map(([, flag]) => legendKey(flag.level, flag.meaning.toLowerCase()))
    .join("");
  return tableSection({
    title: "Cases",
    tableClass: "cases",
    head: `
          <tr>
            <th scope="col">Case</th>${labels.map((label) => `<th scope="col">${esc(label)}</th>`).join("")}
          </tr>`,
    rows,
    note: `Each cell is passes out of graded runs, then the mean number of tool calls in a run. Open a case for its query and what it checks. ${legend}`,
  });
}

function failures(summary) {
  const items = summary.cases.flatMap((c) =>
    Object.entries(c.results)
      .filter(([, r]) => r.reasons.length)
      .map(
        ([label, r]) => `
      <dt>${esc(c.desc)} <span class="aside">${esc(label)}, ${r.passes}/${r.graded} passed</span></dt>${r.reasons.map((reason) => `
      <dd>${esc(reason)}</dd>`).join("")}`,
      ),
  );
  if (!items.length) return "";
  return `
  <section>
    <h2>Why runs failed</h2>
    <dl>${items.join("")}
    </dl>
  </section>`;
}

// The darkest cell stays light enough for the count to read on top of it.
const HEAT_MAX = 42;

function coverage(summary) {
  const labels = summary.models.map((m) => m.label);
  const total = summary.cases.length;
  const heat = (n) =>
    n ? ` style="background:color-mix(in srgb, var(--interval) ${Math.round((n / total) * HEAT_MAX)}%, transparent)"` : "";
  const rows = summary.tools.map(
    (t) => `
        <tr>
          <th scope="row"><code>${esc(t.name)}</code></th>
          <td class="num">${t.neededBy || `${badge("warning", "No case needs it")} 0`}</td>${labels.map((label) => `
          <td class="num"${heat(t.calledIn[label])}>${t.calledIn[label]}</td>`).join("")}
        </tr>`,
  );
  const unchecked = summary.tools.some((t) => !t.neededBy);
  return tableSection({
    title: "Tool coverage",
    tableClass: "coverage",
    head: `
          <tr>
            <th scope="col" rowspan="2">Tool</th>
            <th scope="col" rowspan="2" class="num">Cases that need it</th>
            <th scope="colgroup" colspan="${labels.length}" class="group">Cases where the model called it</th>
          </tr>
          <tr>${labels.map((label) => `<th scope="col" class="num">${esc(label)}</th>`).join("")}
          </tr>`,
    rows,
    note: `Counts are cases, out of ${total}. A case needs a tool when it can't pass without calling it. A model counts as calling it when any graded run did. ${unchecked ? legendKey("warning", "no case fails if the model never calls this tool") : ""}`,
  });
}

function usage(summary) {
  const rows = summary.models.map(
    (m) => `
        <tr>
          <th scope="row">${esc(m.label)}</th>
          <td class="num">${m.graded}</td>
          <td class="num">${m.errors}</td>
          <td class="num">${m.callsPerRun === null ? "–" : mean(m.callsPerRun)}</td>
          <td class="num">${count(m.input)}</td>
          <td class="num">${count(m.output)}</td>
          <td class="num">${m.cost === null ? "unknown" : `$${m.cost.toFixed(3)}`}</td>
          <td class="num">${m.p50Ms === null ? "–" : `${(m.p50Ms / 1000).toFixed(1)}s`}</td>
        </tr>`,
  );
  return tableSection({
    title: "Tokens, cost and latency",
    head: `
          <tr>
            <th scope="col">Model</th>
            <th scope="col" class="num">Graded runs</th>
            <th scope="col" class="num">Errored</th>
            <th scope="col" class="num">Tool calls per run</th>
            <th scope="col" class="num">Input tokens</th>
            <th scope="col" class="num">Output tokens</th>
            <th scope="col" class="num">Estimated cost</th>
            <th scope="col" class="num">Median latency</th>
          </tr>`,
    rows,
    foot: `
        <tfoot>
          <tr>
            <th scope="row" colspan="6">Total</th>
            <td class="num">$${summary.totalCost.toFixed(3)}</td>
            <td></td>
          </tr>
        </tfoot>`,
    note: "Cost is estimated from list prices. Errored runs still use tokens, so they count here.",
  });
}

const STYLE = `
  :root {
    color-scheme: light dark;
    --surface: #fcfcfb;
    --ink: #0b0b0b;
    --ink-2: #52514e;
    --rule: #e1e0d9;
    --axis: #c3c2b7;
    --interval: #2a78d6;
    --warning: #fab219;
    --critical: #d03b3b;
  }
  @media (prefers-color-scheme: dark) {
    :root {
      --surface: #1a1a19;
      --ink: #f0efec;
      --ink-2: #c3c2b7;
      --rule: #2c2c2a;
      --axis: #383835;
      --interval: #3987e5;
    }
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    padding: 3rem 1.5rem 4rem;
    background: var(--surface);
    color: var(--ink);
    font: 1rem/1.5 system-ui, -apple-system, "Segoe UI", sans-serif;
  }
  main { max-width: 60rem; margin: 0 auto; }
  h1 { margin: 0; font-size: 1.75rem; line-height: 1.2; font-weight: 650; letter-spacing: -0.01em; }
  h2 { margin: 3rem 0 0.75rem; font-size: 1.125rem; font-weight: 650; }
  .lede { margin: 0.5rem 0 0; font-size: 1.25rem; }
  .note { margin: 0.75rem 0 0; max-width: 44rem; font-size: 0.875rem; color: var(--ink-2); }
  .sr { position: absolute; width: 1px; height: 1px; overflow: hidden; clip-path: inset(50%); }

  .scroll { overflow-x: auto; }
  table { width: 100%; border-collapse: collapse; font-size: 0.9375rem; }
  th, td { padding: 0.55rem 0.75rem; text-align: left; vertical-align: middle; }
  th:first-child { padding-left: 0; }
  thead th { font-size: 0.8125rem; font-weight: 600; color: var(--ink-2); border-bottom: 1px solid var(--axis); white-space: nowrap; vertical-align: bottom; }
  tbody th { font-weight: 500; white-space: nowrap; }
  .cases tbody th { min-width: 9rem; white-space: normal; }
  tbody tr > *, tfoot tr > * { border-bottom: 1px solid var(--rule); }
  tfoot th { font-weight: 600; }
  .num { text-align: right; font-variant-numeric: tabular-nums; white-space: nowrap; }
  .aside { font-size: 0.8125rem; font-weight: 400; color: var(--ink-2); white-space: nowrap; }

  .plot { width: 40%; min-width: 15rem; }
  .scale, .strip { position: relative; margin: 0 1.25rem; }
  .scale { height: 1.2em; font-weight: 400; }
  .scale span { position: absolute; transform: translateX(-50%); }
  .strip {
    height: 1.5rem;
    background:
      linear-gradient(var(--axis), var(--axis)) 0 50% / 100% 1px no-repeat,
      linear-gradient(var(--axis), var(--axis)) 0 50% / 1px 9px no-repeat,
      linear-gradient(var(--axis), var(--axis)) 50% 50% / 1px 9px no-repeat,
      linear-gradient(var(--axis), var(--axis)) 100% 50% / 1px 9px no-repeat;
  }
  .interval { position: absolute; top: 50%; height: 6px; margin-top: -3px; border-radius: 3px; background: var(--interval); }
  .rate { position: absolute; top: 50%; width: 13px; height: 13px; margin: -6.5px 0 0 -6.5px; border-radius: 50%; background: var(--surface); border: 3px solid var(--ink); }

  .cell, .stack { display: flex; align-items: baseline; gap: 0.5rem; white-space: nowrap; }
  .mark { flex: none; width: 1.25rem; }
  .score { font-variant-numeric: tabular-nums; min-width: 2rem; }
  .badge {
    display: inline-block; width: 1.25rem; height: 1.25rem; border-radius: 50%;
    font-size: 0.75rem; font-weight: 700; line-height: 1.25rem; text-align: center;
  }
  .badge.critical { background: var(--critical); color: #ffffff; }
  .badge.warning { background: var(--warning); color: #0b0b0b; }
  td.critical { background: color-mix(in srgb, var(--critical) 10%, transparent); }
  td.warning { background: color-mix(in srgb, var(--warning) 16%, transparent); }
  .key { display: inline-flex; align-items: center; gap: 0.35rem; margin-left: 0.5rem; white-space: nowrap; }

  summary { cursor: pointer; }
  summary:focus-visible { outline: 2px solid var(--interval); outline-offset: 2px; }
  .about { margin: 0.4rem 0 0.25rem 1.05rem; font-weight: 400; }
  .about p, .about ul { margin: 0 0 0.5rem; }
  .about ul { padding-left: 1.1rem; }
  .cases tr:has(details[open]) > td { vertical-align: top; }

  code { font: 0.8125rem/1.4 ui-monospace, "SF Mono", Menlo, Consolas, monospace; }

  .coverage .group { text-align: center; border-bottom-color: var(--rule); }

  dl { margin: 0; max-width: 52rem; }
  dt { margin-top: 1rem; font-weight: 600; }
  dd { margin: 0.25rem 0 0; padding-left: 0.875rem; border-left: 2px solid var(--critical); overflow-wrap: anywhere; }

  @media (max-width: 40rem) {
    body { padding: 2rem 1rem 3rem; }
    th, td { padding: 0.5rem 0.4rem; }
    .wide { display: none; }
    .plot { min-width: 10rem; }
    .scale, .strip { margin: 0 0.75rem; }
    .cell { gap: 0.25rem; }
    .stack { flex-direction: column; gap: 0; }
    .coverage thead th { white-space: normal; }
  }
`;

export function renderHtml(summary) {
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${esc(summary.run.title)}</title>
<style>${STYLE}</style>
</head>
<body>
<main>${intro(summary)}${passRates(summary.models)}${caseTable(summary)}${failures(summary)}${coverage(summary)}${usage(summary)}
</main>
</body>
</html>
`;
}

// An OSC 8 hyperlink. Not every terminal makes a bare file:// URL clickable,
// and the escape codes would be noise in a pipe or a log.
const hyperlink = (url) =>
  process.stdout.isTTY ? `\x1b]8;;${url}\x1b\\${url}\x1b]8;;\x1b\\` : url;

// The results file only names tools a case expects or a model called, so a
// tool the evals never touch has to come from the server's source.
export function registeredTools() {
  const src = new URL("../src/", import.meta.url);
  return readdirSync(src, { recursive: true })
    .filter((file) => file.endsWith(".ts"))
    .flatMap((file) => [...readFileSync(new URL(file, src), "utf8").matchAll(/registerTool\(\s*"(\w+)"/g)])
    .map((match) => match[1]);
}

export function writeReport(resultsPath) {
  const summary = summarize(JSON.parse(readFileSync(resultsPath, "utf8")), registeredTools());
  const htmlPath = `${resultsPath.replace(/\.json$/, "")}.html`;
  writeFileSync(htmlPath, renderHtml(summary));
  console.log(`${renderText(summary)}\nReport: ${hyperlink(pathToFileURL(htmlPath).href)}`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const path = process.argv[2];
  if (!path) {
    console.error("Usage: node evals/report.js <promptfoo-results.json>");
    process.exit(1);
  }
  writeReport(path);
}
