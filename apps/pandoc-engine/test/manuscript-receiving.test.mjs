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

test("HTML receipt binds layered metadata and the Lua source actually passed to Pandoc",
  { skip: !pandocAvailable && "Pandoc is not installed" }, async t => {
    const rootDir = await mkdtemp(join(tmpdir(), "pandoc-receiving-"));
    t.after(() => rm(rootDir, { recursive: true, force: true }));
    await writeFile(join(rootDir, "paper.md"), "# An observed result\n");
    await writeFile(join(rootDir, "base.yml"), "title: Earlier title\n");
    await writeFile(join(rootDir, "override.yml"), "title: Layered title\n");
    const answer = await projectManuscriptThroughPandoc({ rootDir, parts: ["paper.md"],
      metadataFile: "base.yml", metadataFiles: ["override.yml"], formats: ["html"],
      filters: ["paper-declarations"], citeproc: false, sourceDateEpoch: 1700000000 });
    assert.equal(answer.ok, true, JSON.stringify(answer.refusal));
    const { receipt } = answer;
    assert.deepEqual(receipt.inputs.filter(v => v.role === "metadata").map(v => v.path), ["base.yml", "override.yml"]);
    for (const item of [...receipt.inputs, ...receipt.supportFiles, ...receipt.outputs]) {
      assert.equal(item.ni, ni(await readFile(join(rootDir, item.path))));
    }
    const used = receipt.provenance.activities.find(v => v.id === "render-html").used;
    assert.ok(used.includes("override.yml"));
    const filter = receipt.supportFiles.find(v => v.path.endsWith("paper-declarations.lua"));
    assert.ok(used.includes(filter.path));
    const entity = receipt.provenance.entities.find(v => v.id === receipt.outputs[0].path);
    assert.deepEqual(entity.wasDerivedFrom, used);
    assert.match(await readFile(join(rootDir, receipt.outputs[0].path), "utf8"), /<title>Layered title<\/title>/u);
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
