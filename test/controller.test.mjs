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
import { writeFileSync } from "node:fs";
import { join } from "node:path";
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

/**
 * The commit action's `branch`, which has to survive the boundary as an *absent* field.
 *
 * The form sends an empty string for "extend the branch I am on", and `optionalString` reads
 * that as absent. The empty string would otherwise reach `switch --create ""`, which fails
 * with a git message about a ref rather than anything about the form.
 */
test("the commit action treats an empty branch as none, and a named one as a branch", async t => {
  const { repo, controller } = buildController(t);
  run(repo, "git", ["switch", "feature"]);
  writeFileSync(join(repo, "new.txt"), "new\n");

  const extended = await controller.handle("commit", {
    paths: ["new.txt"],
    message: "feat: extend",
    branch: "",
  });
  assert.equal(extended.ok, true);
  assert.equal(
    /** @type {{ branch: string | null }} */ (extended.data).branch,
    null
  );
  assert.equal(run(repo, "git", ["branch", "--show-current"]), "feature");

  writeFileSync(join(repo, "second.txt"), "second\n");
  const forked = await controller.handle("commit", {
    paths: ["second.txt"],
    message: "feat: fork",
    branch: "side",
  });
  assert.equal(forked.ok, true);
  assert.equal(
    /** @type {{ branch: string | null }} */ (forked.data).branch,
    "side"
  );
  assert.equal(run(repo, "git", ["branch", "--show-current"]), "side");
  // The log is what the command panel prints, so the branch had better be in it.
  const { commands } = present(forked.log, "the commit's command log");
  assert.ok(
    commands.some(command => command.startsWith("git switch --create side")),
    commands.join("\n")
  );
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
 * The rebase payload's boundary: a destination names trunk, the stack base, or a commit, and a
 * commit destination has to name one.
 */
test("a rebase destination outside the three kinds is refused by name", async t => {
  const { controller } = buildController(t);
  const before = await controller.model();
  const commit = present(
    before.rows.find(row => row.type === "commit"),
    "a commit row"
  ).commit;

  const result = await controller.handle("rebase", {
    sha: commit.sha,
    destination: "elsewhere",
  });
  assert.equal(result.ok, false);
  assert.match(result.error, /Unknown rebase destination: elsewhere/);

  const unnamed = await controller.handle("rebase", {
    sha: commit.sha,
    destination: "commit",
  });
  assert.equal(unnamed.ok, false);
  assert.match(unnamed.error, /destinationSha/);
});

test("a rebase onto a named commit reaches the planner, which refuses a commit's own parent", async t => {
  const { controller } = buildController(t);
  const before = await controller.model();
  const commit = present(
    before.rows
      .flatMap(row => (row.type === "commit" ? [row.commit] : []))
      .find(candidate => candidate.parents.length === 1),
    "a commit with one parent"
  );

  const result = await controller.handle("rebase", {
    sha: commit.sha,
    destination: "commit",
    destinationSha: commit.parents[0],
  });
  // The planner's own refusal, which only a parsed commit destination can reach.
  assert.equal(result.ok, false);
  assert.match(result.error, /already sit on that destination/);
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

test("chosen lines are read strictly, since a dropped entry would commit its file whole", () => {
  const entry = {
    path: "a.txt",
    fingerprint: "f",
    excludedRemovals: [2],
    excludedAdditions: [],
  };
  assert.deepEqual(payload.readLineSelections({ lines: [entry] }, "lines"), [
    entry,
  ]);
  assert.deepEqual(payload.readLineSelections({}, "lines"), []);
  assert.throws(
    () => payload.readLineSelections({ lines: "a.txt" }, "lines"),
    /malformed "lines" value/
  );
  for (const broken of [
    { ...entry, path: "" },
    { ...entry, fingerprint: undefined },
    { ...entry, excludedRemovals: [0] },
    { ...entry, excludedAdditions: [1.5] },
    { ...entry, excludedAdditions: undefined },
  ]) {
    assert.throws(
      () => payload.readLineSelections({ lines: [broken] }, "lines"),
      /malformed "lines" entry/
    );
  }
});
