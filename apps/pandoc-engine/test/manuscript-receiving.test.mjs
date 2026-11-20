import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { spawnSync } from "node:child_process";
import test from "node:test";
import { planManuscriptProjection } from "../src/manuscript-plan.mjs";
import { projectManuscriptThroughPandoc } from "../src/manuscript-project.mjs";

const pandocAvailable = spawnSync("pandoc", ["--version"], { encoding: "utf8" }).status === 0;
const ni = bytes => "ni:///sha-256;" + createHash("sha256").update(bytes).digest("base64url");

test("HTML and JATS receipts bind layered metadata, shared Lua, and output-specific styles",
  { skip: !pandocAvailable && "Pandoc is not installed" }, async t => {
    const rootDir = await mkdtemp(join(tmpdir(), "pandoc-receiving-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    await writeFile(join(rootDir, "paper.md"), "# An observed result\n");
    await writeFile(join(rootDir, "base.yml"), "title: Earlier title\n");
    await writeFile(join(rootDir, "override.yml"), "title: Layered title\n");
    await writeFile(join(rootDir, "style.css"), "body { color: navy; }\n");
    const answer = await projectManuscriptThroughPandoc({ rootDir, parts: ["paper.md"],
      metadataFile: "base.yml", metadataFiles: ["override.yml"], formats: ["html", "jats"], css: "style.css",
      filters: ["paper-declarations"], citeproc: false, sourceDateEpoch: 1700000000 });
    assert.equal(answer.ok, true, JSON.stringify(answer.refusal));
    const { receipt } = answer;
    assert.deepEqual(receipt.inputs.filter(v => v.role === "metadata").map(v => v.path), ["base.yml", "override.yml"]);
    for (const item of [...receipt.inputs, ...receipt.supportFiles, ...receipt.outputs]) {
      assert.equal(item.ni, ni(await readFile(join(rootDir, item.path))));
    }
    const filter = receipt.supportFiles.find(v => v.path.endsWith("paper-declarations.lua"));
    for (const output of receipt.outputs) {
      const used = receipt.provenance.activities.find(v => v.id === "render-" + output.format).used;
      assert.ok(used.includes("override.yml"));
      assert.ok(used.includes(filter.path));
      assert.equal(used.includes("style.css"), output.format === "html");
      const entity = receipt.provenance.entities.find(v => v.id === output.path);
      assert.deepEqual(entity.wasDerivedFrom, used);
      const body = await readFile(join(rootDir, output.path), "utf8");
      if (output.format === "html") {
        assert.match(body, /<title>Layered title<\/title>/u);
        assert.match(body, /href="style\.css"/u);
      } else {
        assert.match(body, /<article-title>Layered title<\/article-title>/u);
        assert.doesNotMatch(body, /style\.css/u);
      }
    }
  });

test("a saved plan refuses missing layered metadata before invoking any tool", async () => {
  const planned = planManuscriptProjection({ parts: ["paper.md"], metadataFiles: ["lost.yml"],
    formats: ["html"], citeproc: false, sourceDateEpoch: 1700000000 });
  assert.equal(planned.ok, true);
  let invoked = false;
  const { ok, refusal } = await projectManuscriptThroughPandoc(planned.plan, {
    exists: path => path === "paper.md", runPandoc() { invoked = true; } });
  assert.equal(ok, false);
  assert.equal(refusal.reason, "MissingInput");
  assert.match(refusal.message, /lost\.yml/u);
  assert.equal(invoked, false);
});
