/**
 * The action boundary: payload narrowing and the dispatcher's contract.
 *
 * Payloads arrive as JSON from a webview or an HTTP request, so a missing field is a
 * runtime possibility rather than a type error. These tests pin that a bad payload
 * produces a named complaint instead of reaching git with `undefined`, and that every
 * failure — including one thrown deep inside an operation — comes back as `{ok: false}`
 * rather than escaping to the host.
 */
import assert from "node:assert/strict";
import { test } from "node:test";
import * as payload from "#ui/actionPayload";
import { Controller } from "#ui/controller";
import { run } from "../scripts/git-fixture.mjs";
import { present } from "./present.mjs";
import { stackBranches, trunkRepository } from "./repoFixture.mjs";

/** @typedef {import("#ui/renderModel").RenderModel} RenderModel */

/** @param {import("node:test").TestContext} t */
function buildController(t) {
  const fixture = trunkRepository(t, "gsm-controller-", { file: "f.txt" });
  stackBranches(fixture.repo, [
    { branch: "feature", file: "a.txt", message: "feat: A", content: "A\n" },
  ]);
  return { ...fixture, controller: new Controller(fixture.repository) };
}

test("an unknown action is reported, not thrown", async t => {
  const { controller } = buildController(t);
  const result = await controller.handle("nonsense", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown action: nonsense/);
});

test("a missing required field names the field", async t => {
  const { controller } = buildController(t);
  // Reaching git with `undefined` here would produce an opaque git error; the
  // boundary should say which value the UI failed to send.
  const result = await controller.handle("files", {});
  assert.equal(result.ok, false);
  assert.match(result.error, /"sha"/);
});

test("a failure inside an operation comes back as a result, not an exception", async t => {
  const { controller } = buildController(t);
  // `fold` refuses when the commit below is already on trunk. The host must
  // receive that as a message it can show.
  const model = await controller.model();
  const commit = present(
    model.rows.find(row => row.type === "commit"),
    "a commit row"
  ).commit;
  const result = await controller.handle("fold", { sha: commit.sha });
  assert.equal(result.ok, false);
  assert.match(result.error, /already on trunk/);
});

test("a non-object payload is tolerated rather than crashing the dispatcher", async t => {
  const { controller } = buildController(t);
  // The HTTP host parses a request body that may be anything at all.
  for (const bad of /** @type {unknown[]} */ ([
    null,
    undefined,
    42,
    "string",
    [],
  ])) {
    const result = await controller.handle("model", bad);
    assert.equal(
      result.ok,
      true,
      `payload ${JSON.stringify(bad) ?? "undefined"} should still render`
    );
  }
});

/**
 * The menu offers two rebase destinations, trunk and the stack base, and nothing in the tree
 * drags one commit onto another. `Repository.rebase` still takes a named commit, so the
 * boundary is where that stops being reachable — an unrecognised destination is a payload no
 * reader can have produced.
 */
test("a rebase destination the menu never offers is refused by name", async t => {
  const { controller } = buildController(t);
  const before = await controller.model();
  const commit = present(
    before.rows.find(row => row.type === "commit"),
    "a commit row"
  ).commit;

  const result = await controller.handle("rebase", {
    sha: commit.sha,
    destination: "commit",
    destinationSha: commit.sha,
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown rebase destination: commit/);
});

test("a mutating action returns the fresh model and its command log together", async t => {
  const { repo, controller } = buildController(t);
  const before = await controller.model();
  const commit = present(
    before.rows.find(row => row.type === "commit"),
    "a commit row"
  ).commit;

  const result = await controller.handle("amendMessage", {
    sha: commit.sha,
    message: "feat: A, reworded",
  });
  assert.equal(result.ok, true);
  // The log is what the command panel shows; a mutation with no log would look
  // like nothing happened.
  const log = present(result.log, "the command log");
  assert.equal(log.title, "Amend message");
  assert.ok(log.commands.length > 0);
  // The returned model already reflects the edit, so the UI needs no second read.
  const { model } = /** @type {{ model: RenderModel }} */ (result.data);
  const subjects = model.rows
    .filter(row => row.type === "commit")
    .map(row => row.commit.subject);
  assert.ok(subjects.includes("feat: A, reworded"));
  // And the edit is undoable, since it moved refs.
  assert.equal(model.undoLabel, "Amend message");
  assert.equal(
    run(repo, "git", ["log", "-1", "--format=%s", "feature"]),
    "feat: A, reworded"
  );
});

test("payload readers narrow rather than trusting the input", () => {
  assert.equal(payload.requireString({ sha: "abc" }, "sha"), "abc");
  // An empty string is as useless as an absent one for a ref or a sha.
  assert.throws(() => payload.requireString({ sha: "" }, "sha"), /"sha"/);
  assert.throws(() => payload.requireString({ sha: 42 }, "sha"), /"sha"/);

  assert.equal(payload.optionalString({}, "sha"), undefined);
  assert.equal(payload.optionalString({ sha: "abc" }, "sha"), "abc");

  // Only a literal `true` counts, so a truthy string does not silently enable a flag.
  assert.equal(payload.readFlag({ force: true }, "force"), true);
  assert.equal(payload.readFlag({ force: "yes" }, "force"), false);
  assert.equal(payload.readFlag({}, "force"), false);

  // Non-string entries are dropped rather than reaching git as `undefined`.
  assert.deepEqual(
    payload.readStringList({ ids: ["a", 1, null, "b"] }, "ids"),
    ["a", "b"]
  );
  assert.deepEqual(payload.readStringList({}, "ids"), []);

  // A thrown non-Error still has to produce a readable message.
  assert.equal(payload.errorMessage(new Error("boom")), "boom");
  assert.equal(payload.errorMessage("plain string"), "plain string");
});
