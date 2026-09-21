/**
 * Render-model rows trimmed to the fields the graph reads.
 *
 * Lane assignment needs a commit's sha and first parent, plus the row type, which is what
 * puts a row on the trunk spine. Everything else `buildModel` emits — subjects,
 * badges, branch details — the graph never looks at, so building it would only obscure the
 * topology each test is about.
 */

/** @typedef {import("#ui/renderModel").Row} Row */

/**
 * @param {string} sha
 * @param {string | null} parent
 * @returns {Row}
 */
export function commit(sha, parent) {
  return /** @type {Row} */ ({
    type: "commit",
    commit: { sha, parents: parent ? [parent] : [] },
  });
}

/**
 * @param {string} sha
 * @returns {Row}
 */
export function trunkTip(sha) {
  return /** @type {Row} */ ({ type: "trunk-tip", sha });
}

/**
 * @param {string} sha
 * @returns {Row}
 */
export function base(sha) {
  return /** @type {Row} */ ({ type: "base", sha });
}

/**
 * @param {number} [count]
 * @returns {Row}
 */
export function ellipsis(count = 3) {
  return { type: "ellipsis", count };
}
