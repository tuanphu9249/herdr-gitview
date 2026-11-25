// The Committed view's file list: what the branch's commits changed, merge-base
// → HEAD, with the working tree left out. The files come from the engine's
// `commit-files --sha "<merge-base>..<HEAD>"` (git's diff-tree takes the two
// as trees: the same files, renames and counts as `git diff --numstat -M
// <merge-base> HEAD`), and the list is shaped as a status of its own scope.
// Pure: main.js runs the engine.

export const SECTION = { id: "committed", title: "COMMITTED" };

// The base's merge-base and HEAD of a `--scope branch` status; null when no
// commit of the branch is on top of the base (HEAD is the merge-base: on the
// base branch itself, or before a first commit): nothing to ask.
export function rangeOf(status) {
  const mb = status?.base?.merge_base;
  const head = status?.head;
  return mb && head && mb !== head ? { mb, head } : null;
}

// `commit-files`'s arguments for that range.
export const filesArgs = (status, range, on) => ["commit-files", "--repo", status.root, "--root", "--sha", `${range.mb}..${range.head}`, ...(on ? ["--on", on] : [])];

// The status the list shows: the branch status's repo, branch, HEAD and base,
// with one section of the files (none when there are none: the list says why).
// Each file's `rev` is HEAD's sha: a new HEAD shows the file again in the pane.
export function committedStatus(status, files) {
  const head = status.head ?? null;
  const rows = (files ?? []).map((f) => ({ ...f, rev: head }));
  return { ...status, scope: "committed", sections: rows.length ? [{ ...SECTION, cached: false, files: rows }] : [] };
}
