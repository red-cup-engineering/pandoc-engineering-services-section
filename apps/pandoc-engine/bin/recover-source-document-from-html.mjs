#!/usr/bin/env node
import { recoverSourceDocumentFromHtml, SOURCE_FORMATS, DEFAULT_MINIMUM_MATCH } from "../src/recover-source-document.mjs";
import { resultSchema, runCommand } from "../src/command.mjs";

export { recoverSourceDocumentFromHtml };

export const operationDefinition = {
  name: "recoverSourceDocumentFromHtml",
  description: "Recovers the source document an exported HTML page (Org Mode export or Hugo output) was made from: only the content region, as Org or Markdown, with title, date and tags as front matter and internal links rewritten, plus a word-by-word comparison of the recovered text with the page's text.",
  inputSchema: {
    type: "object",
    required: ["htmlPath", "scratchDir"],
    properties: {
      htmlPath: { type: "string" },
      rootDir: { type: "string" },
      scratchDir: { type: "string" },
      format: { enum: [...SOURCE_FORMATS] },
      linkTargets: { type: "object", additionalProperties: { type: "string" } },
      minimumMatch: { type: "number", exclusiveMinimum: 0, maximum: 1, default: DEFAULT_MINIMUM_MATCH },
      date: { type: "string" },
    },
  },
  outputSchema: resultSchema,
  operation: (request) => recoverSourceDocumentFromHtml(request),
};
export const operation = operationDefinition;

if (import.meta.main) await runCommand(operationDefinition);
