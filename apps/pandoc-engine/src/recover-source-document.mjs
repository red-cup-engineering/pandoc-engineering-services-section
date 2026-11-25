import { readFileSync } from "node:fs";
import { parseJson } from "@red-cup-engineering/json-engine/parse-json";
import { canonicalJson } from "@red-cup-engineering/json-engine/canonical-json";
import { nodePorts } from "./ports.mjs";

/**
 * Recover a source document from an exported HTML page.
 *
 * Org Mode's HTML export and Hugo's output carry a document inside page chrome: navigation,
 * preamble, postamble, styles, scripts, tables of contents, backlinks. When the page is the
 * only copy of the text, this operation takes the document out of it, in the format the
 * original was written in (Org by default), with the title, date and tags turned into the
 * document's own front matter and links to other pages rewritten to where those pages now live.
 * It then renders the recovered source back to text and compares that text, word by word and in
 * order, with the text of the page's content region. Nothing here judges: the comparison is a
 * longest common subsequence of words, and a document below `minimumMatch` is reported as
 * failed so the caller keeps the page.
 */

const FILTER_NAME = "recover-source-from-html.lua";
const FILTER_SOURCE = readFileSync(new URL(`../filters/${FILTER_NAME}`, import.meta.url), "utf8");
export const SOURCE_FORMATS = Object.freeze(["org", "gfm"]);
export const DEFAULT_MINIMUM_MATCH = 0.995;
const MAX_EDIT_DISTANCE = 40000;

const refuse = (reason, message, extra = {}) => Object.freeze({ ok: false, refusal: Object.freeze({ reason, message }), ...extra });
const isRelative = (path) => typeof path === "string" && path !== "" && !path.startsWith("/") && !path.startsWith("-") && !path.includes("\\") && !path.split("/").includes("..");

/** Text of a pandoc inline list, as pandoc's own `stringify` makes it. */
export function stringifyInlines(node) {
  if (Array.isArray(node)) return node.map(stringifyInlines).join("");
  if (node === null || typeof node !== "object") return "";
  switch (node.t) {
    case "Str": return node.c;
    case "Space": case "SoftBreak": return " ";
    case "LineBreak": return "\n";
    case "Code": return node.c[1];
    case "Math": return node.c[1];
    case "Link": case "Image": return stringifyInlines(node.c[1]);
    case "Span": return stringifyInlines(node.c[1]);
    case "Quoted": return node.c[0].t === "DoubleQuote" ? `“${stringifyInlines(node.c[1])}”` : `‘${stringifyInlines(node.c[1])}’`;
    case "Cite": return stringifyInlines(node.c[1]);
    case "Note": return "";
    default: return node.c === undefined ? "" : stringifyInlines(node.c);
  }
}

/** Walk every node of a pandoc JSON tree, calling `visit(node)` on each object. */
function walkTree(node, visit) {
  if (Array.isArray(node)) { for (const child of node) walkTree(child, visit); return; }
  if (node === null || typeof node !== "object") return;
  visit(node);
  for (const value of Object.values(node)) walkTree(value, visit);
}

const stripFragment = (target) => target.replace(/#.*$/u, "");
const isInternalPage = (target) => !/^[A-Za-z][A-Za-z0-9+.-]*:/u.test(target) ? stripFragment(target) !== "" : /^https?:\/\/emsenn\.net\//u.test(target);

/**
 * Rewrite links between pages to the addresses the caller says those pages now have.
 * `linkTargets` maps a page address as it appears in the page (`slug.html`, `./slug.html`,
 * a full URL) to the address to use. Returns the addresses it rewrote and the internal
 * addresses it had no answer for.
 */
export function rewriteInternalLinks(blocks, linkTargets) {
  const rewritten = [], unresolved = [];
  walkTree(blocks, (node) => {
    if (node.t !== "Link") return;
    const [, , target] = node.c;
    const address = target[0];
    if (address.startsWith("#")) return;
    const base = stripFragment(address);
    const key = [address, base, base.replace(/^\.\//u, ""), base.replace(/\/$/u, "")].find((candidate) => Object.hasOwn(linkTargets, candidate));
    if (key !== undefined) {
      target[0] = linkTargets[key];
      node.c[0] = ["", [], []];
      rewritten.push(address);
    } else if (isInternalPage(address)) unresolved.push(address);
  });
  return { rewritten, unresolved };
}

/** Org's first inactive timestamp in a title, `[2025-09-01 Mon 10:09]`, or a bare `[2020-08-06 Thu 11:12]` title. */
export function timestampOf(text) {
  return /\[\d{4}-\d{2}-\d{2}(?: [A-Za-z]{3})?(?: \d{2}:\d{2})?\]/u.exec(text)?.[0];
}

// Words of a text, in order.  Footnote markers are exporter numbering, not the author's words.
const FOOTNOTE_MARKER = /^(?:\[\d+\]|\^\(\d+,?\)|[¹²³⁰-⁹]+)[,.;:]?$/u;
// Org's HTML export prints straight quotes, `--` and `...` as typographic characters; pandoc writes them back
// as typed.  Folding both sides to the typed form compares the characters the author typed.
const TYPOGRAPHY = [[/[\u2018\u2019]/gu, "'"], [/[\u201c\u201d]/gu, '"'], [/\u2014/gu, "---"], [/\u2013/gu, "--"], [/\u2026/gu, "..."], [/\u00a0/gu, " "]];
export function wordsOf(text, { dropFootnoteMarkers = true } = {}) {
  const typed = TYPOGRAPHY.reduce((value, [pattern, replacement]) => value.replace(pattern, replacement), text);
  return typed.split(/\s+/u).filter((word) => word !== "" && !(dropFootnoteMarkers && FOOTNOTE_MARKER.test(word)));
}

/**
 * Length of the longest common subsequence of two word lists, by Myers' O(ND) algorithm.
 * Returns undefined when the lists differ by more than `limit` insertions and deletions.
 */
export function commonSubsequenceLength(left, right, limit = MAX_EDIT_DISTANCE) {
  const n = left.length, m = right.length, max = Math.min(n + m, limit);
  const offset = max + 1;
  let frontier = new Int32Array(2 * max + 3);
  for (let d = 0; d <= max; d += 1) {
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && frontier[offset + k - 1] < frontier[offset + k + 1]) ? frontier[offset + k + 1] : frontier[offset + k - 1] + 1;
      let y = x - k;
      while (x < n && y < m && left[x] === right[y]) { x += 1; y += 1; }
      frontier[offset + k] = x;
      if (x >= n && y >= m) return (n + m - d) / 2;
    }
  }
  return undefined;
}

/** Compare the words of the page's content region with the words of the recovered source, rendered back to text. */
export function compareWords(originalText, recoveredText) {
  const original = wordsOf(originalText), recovered = wordsOf(recoveredText);
  const common = commonSubsequenceLength(original, recovered);
  const longest = Math.max(original.length, recovered.length);
  const matched = common ?? 0;
  return { originalWords: original.length, recoveredWords: recovered.length, matchedWords: matched, match: longest === 0 ? 1 : matched / longest };
}

function frontMatter(format, { title, date, keywords, literalScripts }) {
  if (format === "org") {
    const lines = [`#+title: ${title}`];
    if (date !== undefined) lines.push(`#+date: ${date}`);
    if (keywords.length > 0) lines.push(`#+keywords: ${keywords.join(", ")}`);
    // The page printed underscores and carets as they are; without this Org would read `a_b` as a subscript.
    if (literalScripts) lines.push("#+options: ^:nil");
    return `${lines.join("\n")}\n\n`;
  }
  const quote = (text) => JSON.stringify(text);
  const lines = ["---", `title: ${quote(title)}`];
  if (date !== undefined) lines.push(`date: ${quote(date)}`);
  if (keywords.length > 0) lines.push(`keywords: [${keywords.map(quote).join(", ")}]`);
  lines.push("---");
  return `${lines.join("\n")}\n\n`;
}

async function pandoc(runPandoc, argv, input) {
  const result = await runPandoc({ command: "pandoc", argv, env: {}, input });
  if (result.status !== 0) return { failure: result.error ?? (result.stderr.trim() || `status ${result.status}`) };
  return { stdout: result.stdout };
}

function admitJson(text) {
  const parsed = parseJson({ text });
  return parsed.ok ? parsed.value : undefined;
}

/**
 * @param {{htmlPath: string, rootDir?: string, scratchDir: string, format?: "org"|"gfm", linkTargets?: Record<string,string>, minimumMatch?: number, date?: string}} request
 *   `htmlPath` and `scratchDir` are relative to `rootDir`; the filter is written under `scratchDir`.
 * @param {{runPandoc?: Function, readFile?: Function, writeFile?: Function}} [ports]
 * @returns {Promise<object>} `{ok: true, document, verification}` or a refusal.
 */
export async function recoverSourceDocumentFromHtml(request, ports = {}) {
  if (request === null || typeof request !== "object" || Array.isArray(request)) return refuse("InvalidRequest", "request must be an object");
  const { htmlPath, rootDir = ".", scratchDir, format = "org", linkTargets = {}, minimumMatch = DEFAULT_MINIMUM_MATCH } = request;
  if (!isRelative(htmlPath)) return refuse("PathEscapesRoot", "htmlPath must be a relative path inside rootDir");
  if (!isRelative(scratchDir)) return refuse("PathEscapesRoot", "scratchDir must be a relative path inside rootDir");
  if (!SOURCE_FORMATS.includes(format)) return refuse("UnsupportedFormat", `format must be one of ${SOURCE_FORMATS.join(", ")}`);
  if (typeof minimumMatch !== "number" || minimumMatch <= 0 || minimumMatch > 1) return refuse("InvalidRequest", "minimumMatch must be in (0, 1]");
  const node = nodePorts(rootDir);
  const runPandoc = ports.runPandoc ?? node.runPandoc;
  const writeFile = ports.writeFile ?? node.writeFile;
  const filterPath = `${scratchDir}/${FILTER_NAME}`;
  // Shipped once per scratch directory; callers running many pages at once must not rewrite it under each other.
  const shipped = (() => { try { return new TextDecoder().decode((ports.readFile ?? node.readFile)(filterPath)); } catch { return undefined; } })();
  if (shipped !== FILTER_SOURCE) writeFile(filterPath, new TextEncoder().encode(FILTER_SOURCE));

  const extract = (mode) => pandoc(runPandoc, ["--from", "html+tex_math_single_backslash", "--to", "json", "--lua-filter", filterPath, "--metadata", `recovery-mode=${mode}`, htmlPath]);
  const region = await extract("region");
  if (region.failure !== undefined) return refuse("PandocFailed", `reading ${htmlPath}: ${region.failure}`);
  const recovery = await extract("recover");
  if (recovery.failure !== undefined) return refuse("PandocFailed", `reading ${htmlPath}: ${recovery.failure}`);
  const regionDocument = admitJson(region.stdout), recoveredDocument = admitJson(recovery.stdout);
  if (regionDocument === undefined || recoveredDocument === undefined) return refuse("PandocFailed", "pandoc wrote a document that is not JSON");

  const meta = recoveredDocument.meta;
  const title = stringifyInlines(meta.title?.c ?? []).trim();
  if (title === "") return refuse("NoTitle", `${htmlPath} has no level-one heading to take as the title`);
  const metaText = (value) => (typeof value?.c === "string" ? value.c : stringifyInlines(value?.c ?? []));
  const keywords = (meta.keywords?.c ?? []).map(metaText);
  const explicitDate = meta.date === undefined ? undefined : metaText(meta.date);
  const date = request.date ?? explicitDate ?? timestampOf(title);

  const links = rewriteInternalLinks(recoveredDocument.blocks, linkTargets);
  regionDocument.meta.title = { t: "MetaInlines", c: [{ t: "Str", c: title }] };
  if (date !== undefined) regionDocument.meta.date = { t: "MetaInlines", c: [{ t: "Str", c: date }] };
  // The page's content region as plain text, with the same title and date on top.
  const original = await pandoc(runPandoc, ["--from", "json", "--to", "plain", "--standalone", "--wrap=none"], canonicalJson(regionDocument));
  if (original.failure !== undefined) return refuse("PandocFailed", `rendering the page's content region: ${original.failure}`);
  const body = await pandoc(runPandoc, ["--from", "json", "--to", format === "org" ? "org" : "gfm", "--wrap=none"], canonicalJson(recoveredDocument));
  if (body.failure !== undefined) return refuse("PandocFailed", `writing ${format}: ${body.failure}`);
  const source = `${frontMatter(format, { title, date, keywords, literalScripts: /[_^]/u.test(original.stdout) })}${body.stdout.replace(/^\n+/u, "")}`;
  const recoveredText = await pandoc(runPandoc, ["--from", format === "org" ? "org" : "gfm+yaml_metadata_block", "--to", "plain", "--standalone", "--wrap=none"], source);
  if (recoveredText.failure !== undefined) return refuse("PandocFailed", `rendering the recovered source: ${recoveredText.failure}`);
  const comparison = compareWords(original.stdout, recoveredText.stdout);
  const verification = { ...comparison, minimumMatch, passed: comparison.match >= minimumMatch };

  return Object.freeze({
    ok: true,
    document: { format, source, title, ...(date === undefined ? {} : { date }), keywords, links, text: recoveredText.stdout },
    verification,
  });
}
