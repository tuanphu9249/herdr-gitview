// The list's selection rules (filelist.js): which row stays selected when
// a new status comes, and J/K's next file.
import "./stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const { FileList } = await import("../mods/gitview/filelist.js");

const f = (path) => ({ path, kind: "modified", letter: "M", add: 1, del: 1, rev: `rev-${path}` });
const status = (changes, staged = []) => ({
  sections: [
    ...(staged.length ? [{ id: "staged", title: "Staged", cached: true, files: staged.map(f) }] : []),
    { id: "changes", title: "Changes", files: changes.map(f) },
  ],
});
const WHERE = { root: "/r", on: null, base: null };
const list = (st, tree = false) => {
  const l = new FileList(st, WHERE);
  l.rebuild(tree);
  return l;
};
const sel = (l) => l.row()?.key ?? null;

test("a file just staged stays selected, in its new section (the pane follows it)", () => {
  const l = list(status(["a.rs", "b.rs"]));
  l.select(l.find("b.rs"));
  l.update(status(["a.rs"], ["b.rs"]), WHERE);
  assert.equal(sel(l), "staged:b.rs");
});

test("a file that went (discarded): the file now where it was, else the last one", () => {
  const l = list(status(["a.rs", "b.rs", "c.rs"]));
  l.select(l.find("b.rs"));
  l.update(status(["a.rs", "c.rs"]), WHERE);
  assert.equal(sel(l), "changes:c.rs");
  l.update(status(["a.rs"]), WHERE);
  assert.equal(sel(l), "changes:a.rs");
  l.update(status([]), WHERE);
  assert.equal(sel(l), null);
});

test("a partly staged file: each section's row is its own (findFile by section)", () => {
  const l = list(status(["a.rs"], ["a.rs"]));
  assert.equal(l.findFile("a.rs", "changes").key, "changes:a.rs");
  assert.equal(l.findFile("a.rs", "staged").key, "staged:a.rs");
});

test("J on the last file is null (the pane says \"last file\"), K on the first too", () => {
  const l = list(status(["a.rs", "b.rs"]));
  const view = (p) => l.viewFor(l.find(p));
  assert.equal(l.stepFile(view("a.rs"), 1).key, "changes:b.rs");
  assert.equal(l.stepFile(view("b.rs"), 1), null);
  assert.equal(l.stepFile(view("a.rs"), -1), null);
});

test("J goes on across sections, in the order the list shows", () => {
  const l = list(status(["c.rs"], ["a.rs"]));
  assert.equal(l.stepFile(l.viewFor(l.find("in:staged:a.rs")), 1).key, "changes:c.rs");
});

test("J into a folded folder (tree mode) unfolds it and selects the file", () => {
  const l = list(status(["src/x.rs", "src/y.rs", "z.rs"]), true);
  l.toggleFold(l.find("src/"));
  assert.equal(l.rows.some((r) => r.key === "changes:src/x.rs"), false);
  const first = l.stepFile({ path: "z.rs", section: "changes" }, -1);
  assert.equal(first.key, "changes:src/y.rs");
  assert.ok(l.rows.includes(first));
});

// The header's "+A −D" (v1's rule: one entry per section, binary adds nothing).
test("line totals count a file in both sections twice and skip binary files", async () => {
  const { lineTotals } = await import("../mods/gitview/model.js");
  const sections = [
    { id: "staged", files: [{ path: "a.rs", add: 3, del: 1 }, { path: "logo.png", add: null, del: null }] },
    { id: "changes", files: [{ path: "a.rs", add: 2, del: 0 }, { path: "b.rs", add: 0, del: 4 }] },
  ];
  assert.deepEqual(lineTotals(sections), { add: 5, del: 5 });
  assert.deepEqual(lineTotals([{ id: "changes", files: [{ path: "x.bin" }] }]), { add: 0, del: 0 });
  assert.deepEqual(lineTotals(undefined), { add: 0, del: 0 });
});

// ---- a section's fold (a click on its header) ---------------------------------

const keys = (l) => l.rows.map((r) => r.key);

test("a folded section keeps its header (and count) and hides its rows; the other sections stay", () => {
  const l = list(status(["c.rs", "d.rs"], ["a.rs", "b.rs"]));
  l.toggleSection("changes");
  assert.deepEqual(keys(l), ["h:staged", "staged:a.rs", "staged:b.rs", "h:changes"]);
  const header = l.rows.find((r) => r.key === "h:changes");
  assert.equal(header.folded, true);
  assert.equal(header.section.files.length, 2);
  l.toggleSection("changes");
  assert.deepEqual(keys(l), ["h:staged", "staged:a.rs", "staged:b.rs", "h:changes", "changes:c.rs", "changes:d.rs"]);
  assert.equal(l.rows.find((r) => r.key === "h:changes").folded, false);
});

test("the fold survives a new status (the list is rebuilt on every refresh) and a new list of the view", () => {
  const folds = new Set();
  const l = new FileList(status(["c.rs"], ["a.rs"]), WHERE, folds);
  l.rebuild(false);
  l.toggleSection("staged");
  l.update(status(["c.rs", "e.rs"], ["a.rs", "b.rs"]), WHERE);
  assert.deepEqual(keys(l), ["h:staged", "h:changes", "changes:c.rs", "changes:e.rs"]);
  const again = new FileList(status(["c.rs"], ["a.rs"]), WHERE, folds);
  again.rebuild(false);
  assert.deepEqual(keys(again), ["h:staged", "h:changes", "changes:c.rs"]);
});

test("folds work in tree mode too, and a folder's own fold is its own", () => {
  const l = list(status(["src/x.rs", "src/y.rs"], ["z.rs"]), true);
  l.toggleSection("changes");
  assert.deepEqual(keys(l), ["h:staged", "staged:z.rs", "h:changes"]);
  l.toggleSection("changes");
  l.toggleFold(l.find("src/"));
  assert.equal(l.rows.some((r) => r.key === "changes:src/x.rs"), false);
  assert.equal(l.rows.find((r) => r.key === "h:changes").folded, false);
});

test("j and k skip a folded section's rows, also from a row the fold hid", () => {
  const l = list(status(["c.rs", "d.rs"], ["a.rs", "b.rs"]));
  l.toggleSection("changes");
  l.select(l.find("in:staged:b.rs"));
  assert.equal(l.step(1).key, "staged:b.rs"); // the last shown row: stays
  l.toggleSection("changes");
  l.select(l.find("in:changes:c.rs"));
  l.toggleSection("changes"); // the selected row goes under the fold
  assert.equal(l.row(), null);
  assert.equal(l.step(-1).key, "staged:b.rs");
  assert.equal(l.step(1).key, "staged:b.rs");
  const none = list(status(["c.rs"]));
  none.toggleSection("changes");
  assert.equal(none.step(1), null);
});

test("a refresh leaves the selection under a fold where it is, unless the file is gone", () => {
  const l = list(status(["c.rs", "d.rs"], ["a.rs"]));
  l.select(l.find("in:changes:d.rs"));
  l.toggleSection("changes");
  l.update(status(["c.rs", "d.rs"], ["a.rs"]), WHERE);
  assert.deepEqual(l.selected, { section: "changes", path: "d.rs" });
  l.update(status(["c.rs"], ["a.rs"]), WHERE);
  assert.notDeepEqual(l.selected, { section: "changes", path: "d.rs" });
});

test("a file in a folded section is found where it is, and opens its section only when asked to show it", () => {
  const l = list(status(["c.rs"], ["a.rs"]));
  l.toggleSection("changes");
  const there = l.findFile("c.rs", "changes", { keepFolds: true });
  assert.equal(there.key, "changes:c.rs");
  assert.equal(l.folded.has("changes"), true); // the pane's refresh follows its file; the fold stays
  assert.equal(l.findFile("c.rs", "changes").key, "changes:c.rs");
  assert.equal(l.folded.has("changes"), false); // J / a handoff / a note's file: it unfolds
  assert.ok(keys(l).includes("changes:c.rs"));
});

test("J from the diff pane goes on into a folded section and opens it", () => {
  const l = list(status(["c.rs"], ["a.rs"]));
  l.toggleSection("changes");
  const next = l.stepFile(l.viewFor(l.find("in:staged:a.rs")), 1);
  assert.equal(next.key, "changes:c.rs");
  assert.ok(l.rows.includes(next));
});
