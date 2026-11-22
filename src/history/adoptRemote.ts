/**
 * adoptRemote — move each layer of a stack onto the commit that its remote already holds.
 *
 * GitHub restacks a stack whenever one of its pull requests merges: GitHub retargets the new bottom
 * pull request at the trunk, then force-pushes every remaining branch onto the squash commit. A
 * checkout that has only fetched since that restack still points at the pre-rebase commits, so
 * `syncBadge` marks every layer diverged even though the remote holds the commits that the pull
 * requests name. A local rebase reaches those same trees under new shas, and a submit then
 * force-pushes all of them, which restarts each check and marks the review comments outdated.
 * `adoptRemoteStack` takes the remote's commits instead, and pushes nothing.
 *
 * Two refusals make the action safe to run. `--cherry-pick` drops every local commit whose patch is
 * already on the remote, so each commit that survives the filter exists nowhere else.
 * `^<trunk>` drops trunk's own commits as well. A layer that a local rebase moved onto a newer
 * trunk carries those commits, and they belong to trunk rather than to the layer. Without that
 * exclusion, the check refuses the half-finished restack that this module repairs. The second
 * refusal compares the commit messages, because a reword leaves the patch identical and
 * `--cherry-pick` matches on the patch alone.
 *
 * One `update-ref --stdin` batch moves every layer, and each update names the sha that the
 * preceding ref read returned, so `update-ref` refuses the whole batch when a branch has moved
 * since then. The checked-out
 * layer stays out of that batch: its working copy has to move with the branch, so `git reset` moves
 * that layer on its own. The undo checkpoint that the caller takes covers both writes.
 */
import { FIELD_SEPARATOR, GitError, GitRunner } from "#git/runner";

const COMMAND = "adopt remote";

export type AdoptLayer = {
  branch: string;
  localSha: string;
  /** Remote-tracking ref that the branch moves onto, in short form: `origin/feature`. */
  remoteRef: string;
  remoteSha: string;
};

export type SkippedLayer = {
  branch: string;
  /** Why the layer stays where it is, phrased for the toast that reports it. */
  reason: string;
};

export type AdoptOutcome = {
  /** Branches moved onto their remote's commit, bottom to top. */
  moved: string[];
  /** Branches whose remote already held the commit that the branch was on. */
  current: string[];
  /** Layers with no remote commit to adopt, each carrying the reason. */
  skipped: SkippedLayer[];
  /** The layer HEAD was on, whose working copy moved with it. Null when HEAD sat elsewhere. */
  checkedOut: string | null;
};

type LayerRef = {
  branch: string;
  localSha: string;
  /** Empty when the branch tracks nothing. */
  remoteRef: string;
  /** Null when the branch tracks a ref that this checkout does not have. */
  remoteSha: string | null;
  /** The upstream is configured, and the remote-tracking ref for it is gone. */
  gone: boolean;
};

/** The commit that each remote-tracking ref points at, keyed by short ref name. */
async function readRemoteShas(
  git: GitRunner,
  refs: string[]
): Promise<Map<string, string>> {
  if (!refs.length) {
    return new Map();
  }
  const output = await git.run([
    "for-each-ref",
    `--format=%(refname:short)${FIELD_SEPARATOR}%(objectname)`,
    ...refs.map(ref => `refs/remotes/${ref}`),
  ]);
  const shas = new Map<string, string>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [ref, sha] = line.split(FIELD_SEPARATOR);
    if (ref && sha) {
      shas.set(ref, sha);
    }
  }
  return shas;
}

/**
 * Where every layer sits, and where its remote does, bottom to top.
 *
 * Two ref reads rather than a `rev-parse` per layer. The last step re-orders the rows into the
 * stack's own order, because `for-each-ref` sorts by ref name, which says nothing about which layer
 * is which.
 */
async function readLayerRefs(
  git: GitRunner,
  branches: string[]
): Promise<LayerRef[]> {
  const format = [
    "%(refname:short)",
    "%(objectname)",
    "%(upstream:short)",
    "%(upstream:track,nobracket)",
  ].join(FIELD_SEPARATOR);
  const output = await git.run([
    "for-each-ref",
    `--format=${format}`,
    ...branches.map(branch => `refs/heads/${branch}`),
  ]);
  const rows = new Map<string, Omit<LayerRef, "branch" | "remoteSha">>();
  for (const line of output.split("\n").filter(Boolean)) {
    const [branch = "", localSha = "", remoteRef = "", track = ""] =
      line.split(FIELD_SEPARATOR);
    rows.set(branch, { localSha, remoteRef, gone: track === "gone" });
  }
  const remoteShas = await readRemoteShas(
    git,
    [...rows.values()].map(row => row.remoteRef).filter(Boolean)
  );
  return branches.flatMap(branch => {
    const row = rows.get(branch);
    if (!row) {
      return [];
    }
    return [
      { branch, ...row, remoteSha: remoteShas.get(row.remoteRef) ?? null },
    ];
  });
}

/** The revisions that a gate compares, minus trunk's commits when the snapshot names a trunk. */
function gateRange(layer: AdoptLayer, trunkRef: string | null): string[] {
  const range = [`${layer.branch}...${layer.remoteRef}`];
  return trunkRef ? [...range, `^${trunkRef}`] : range;
}

/** How many commits on this layer exist nowhere but here — the work that a move would destroy. */
async function unmatchedLocalCommits(
  git: GitRunner,
  layer: AdoptLayer,
  trunkRef: string | null
): Promise<number> {
  const count = await git.run([
    "rev-list",
    "--count",
    "--cherry-pick",
    "--left-only",
    ...gateRange(layer, trunkRef),
  ]);
  return parseInt(count.trim(), 10) || 0;
}

/**
 * Subjects of the commits that both sides share, newest first, from whichever side `side` names.
 *
 * Reads the pairs that the unmatched-commit count deliberately ignores. `--cherry-mark` keeps the
 * shared commits and marks them `=`, where `--cherry-pick` drops them.
 */
async function pairedSubjects(
  git: GitRunner,
  layer: AdoptLayer,
  trunkRef: string | null,
  side: "--left-only" | "--right-only"
): Promise<string[]> {
  const output = await git.run([
    "log",
    `--format=%m${FIELD_SEPARATOR}%s`,
    "--cherry-mark",
    side,
    ...gateRange(layer, trunkRef),
  ]);
  return output
    .split("\n")
    .filter(Boolean)
    .flatMap(line => {
      const [mark, subject = ""] = line.split(FIELD_SEPARATOR);
      return mark === "=" ? [subject] : [];
    });
}

/**
 * Refuse the whole action when any layer would lose something, naming the layer and what to do.
 *
 * Called before the first ref moves, and covers every layer rather than stopping at the first, so
 * one refusal names every layer that blocks the move rather than one per attempt.
 */
async function requireNothingToLose(
  git: GitRunner,
  movers: AdoptLayer[],
  trunkRef: string | null
): Promise<void> {
  const refusals: string[] = [];
  for (const layer of movers) {
    const unmatched = await unmatchedLocalCommits(git, layer, trunkRef);
    if (unmatched) {
      refusals.push(
        `${layer.branch} holds ${unmatched} commit(s) that ${layer.remoteRef} does not — submit or move them first`
      );
      continue;
    }
    const [local, remote] = await Promise.all([
      pairedSubjects(git, layer, trunkRef, "--left-only"),
      pairedSubjects(git, layer, trunkRef, "--right-only"),
    ]);
    if (local.join("\n") !== remote.join("\n")) {
      refusals.push(
        `${layer.branch} and ${layer.remoteRef} carry the same changes under different commit messages, so the move would replace the local wording — submit ${layer.branch} first`
      );
    }
  }
  if (refusals.length) {
    throw new GitError(`${refusals.join(". ")}. Nothing was changed.`, COMMAND);
  }
}

/** Distinct remotes that the layers track, so one fetch covers each remote. */
function remotesOf(layers: LayerRef[]): string[] {
  const remotes = new Set<string>();
  for (const layer of layers) {
    const remote = layer.remoteRef.split("/")[0];
    if (remote) {
      remotes.add(remote);
    }
  }
  return [...remotes];
}

/**
 * Point every layer of a stack at the commit that its remote holds.
 *
 * The fetch comes first, and the second ref read comes after it. Before a fetch, a remote-tracking
 * ref still holds whatever the previous fetch left, so a move onto those commits would put the
 * stack on commits that GitHub replaced hours ago.
 */
export async function adoptRemoteStack(
  git: GitRunner,
  branches: string[],
  trunkRef: string | null,
  headBranch: string | null
): Promise<AdoptOutcome> {
  for (const remote of remotesOf(await readLayerRefs(git, branches))) {
    await git.run(["fetch", remote]);
  }
  const layers = await readLayerRefs(git, branches);

  const skipped: SkippedLayer[] = [];
  const current: string[] = [];
  const movers: AdoptLayer[] = [];
  for (const layer of layers) {
    if (!layer.remoteRef) {
      skipped.push({
        branch: layer.branch,
        reason: "it tracks no remote branch",
      });
      continue;
    }
    if (layer.gone || !layer.remoteSha) {
      skipped.push({
        branch: layer.branch,
        reason: `${layer.remoteRef} no longer exists`,
      });
      continue;
    }
    if (layer.remoteSha === layer.localSha) {
      current.push(layer.branch);
      continue;
    }
    movers.push({ ...layer, remoteSha: layer.remoteSha });
  }

  await requireNothingToLose(git, movers, trunkRef);

  const headLayer = movers.find(layer => layer.branch === headBranch);
  const batch = movers.filter(layer => layer !== headLayer);
  if (batch.length) {
    await git.run(["update-ref", "--stdin", "-z"], {
      input: batch
        .map(
          layer =>
            `update refs/heads/${layer.branch}\0${layer.remoteSha}\0${layer.localSha}\0`
        )
        .join(""),
    });
  }
  if (headLayer) {
    // `--keep` rather than `--hard`: `git reset --keep` refuses the reset when it would overwrite
    // an edited file, rather than discarding the edit. That covers the one dirty file that the
    // caller's clean-tree check could miss.
    await git.run(["reset", "--keep", headLayer.remoteSha]);
  }

  return {
    moved: movers.map(layer => layer.branch),
    current,
    skipped,
    checkedOut: headLayer?.branch ?? null,
  };
}
