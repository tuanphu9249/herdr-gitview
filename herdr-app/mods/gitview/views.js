// The list's views of the repo: the one table the header's control, the `w`
// key, the keys that act on files and the engine's scope all read. Pure data,
// no drawing. Adding a view is one more entry here (and its load in main.js).
//   id          what the list remembers and keys its place by
//   title       the control's text
//   scope       the engine's `--scope` for its file list
//   actsOnWork  s / u / x and the commit box work in it (the working tree)
//   usesBase    it is "against a base": the base picker shows
//   to          the new side of its diffs: null (the working tree) or "head"
//               (the engine's `diff --to head`: committed changes only; the
//               file list is then `commit-files --sha "<mb>..<HEAD>"`)

export const VIEWS = [
  { id: "uncommitted", title: "Uncommitted", scope: "worktree", actsOnWork: true, usesBase: false, to: null },
  { id: "branch", title: "Branch", scope: "branch", actsOnWork: false, usesBase: true, to: null },
  { id: "committed", title: "Committed", scope: "branch", actsOnWork: false, usesBase: true, to: "head" },
];

export const DEFAULT_VIEW = "uncommitted";

// The view called `id` (an unknown id: the default one).
export const viewById = (id) => VIEWS.find((v) => v.id === id) ?? VIEWS[0];

// `w`: the next view in the table, the first after the last.
export const nextView = (id) => VIEWS[(VIEWS.findIndex((v) => v.id === id) + 1) % VIEWS.length];

// The list's text when the view has no files. The Committed view's is not
// an error: HEAD is the base's merge-base (on the base branch itself, or
// nothing committed on top of it yet).
export const emptyText = (view, baseLabel = null) =>
  view.to ? `Nothing committed yet: HEAD is the merge-base with ${baseLabel ?? "the base"}, so no commit of this branch is on top of it.` : "No changes";

// The keys card's and the footer's label for `w`: "uncommitted / branch / committed".
export const toggleLabel = () => VIEWS.map((v) => v.title.toLowerCase()).join(" / ");
