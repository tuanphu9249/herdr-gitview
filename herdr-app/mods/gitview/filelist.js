// A list of changed files: the working tree's (its status) or one commit's.
// The same rows, selection and folding either way; `where` says which repo,
// on which machine, and for a commit which one: it was loaded with the
// status, so an op always goes to the repo the rows came from.

import { entryOf, fileOrder, lineTotals, listRows, parentDirs, viewOf } from "./model.js";

// Where a row is, as the selection keeps it: {section, path} (a folder's
// path ends in "/"). Section headers aren't selectable.
const spotOf = (row) => (row && row.kind !== "header" ? { section: row.section.id, path: row.kind === "file" ? row.file.path : row.path } : null);
const isAt = (row, spot) =>
  Boolean(spot) && row.kind !== "header" && row.section.id === spot.section && (row.kind === "file" ? row.file.path : row.path) === spot.path;

export class FileList {
  // status: the engine's `status` (or `{sections}` for a commit);
  // where: {root, on, base, commit?, short?, subject?};
  // folded: the ids of the sections whose rows are hidden (the caller keeps
  // the set, so a rebuilt list folds as the one before did).
  constructor(status, where, folded = new Set()) {
    this.status = status;
    this.where = where;
    this.selected = null; // {section, path}
    this.collapsed = new Set();
    this.folded = folded;
    this.rows = [];
    this.order = [];
  }

  rebuild(tree) {
    this.tree = tree;
    this.rows = listRows(this.status, { tree, collapsed: this.collapsed, folded: this.folded });
    // Every row as it would show with no section folded: j/k from a row a
    // fold hid still know where it was.
    this.order = this.folded.size ? listRows(this.status, { tree, collapsed: this.collapsed }) : this.rows;
  }

  // Fold or unfold a section (a click on its header). The selection stays
  // where it was, hidden or not.
  toggleSection(id) {
    if (this.folded.has(id)) this.folded.delete(id);
    else this.folded.add(id);
    this.rebuild(this.tree);
  }

  // Whether the spot is a file or folder of the status now.
  holds(spot) {
    const files = this.status?.sections.find((s) => s.id === spot.section)?.files ?? [];
    return spot.path.endsWith("/") ? files.some((f) => f.path.startsWith(spot.path)) : files.some((f) => f.path === spot.path);
  }

  // A new status for the same list: the same row, else the same file in its
  // new section (just staged), else (it went) the file now where it was,
  // else the last one.
  update(status, where) {
    const was = this.selected;
    const index = this.selectedIndex();
    this.status = status;
    this.where = where;
    this.rebuild(this.tree);
    // (A row a fold hides is still the selection.)
    if (!was || this.row() || (this.folded.has(was.section) && this.holds(was))) return;
    const folder = was.path.endsWith("/");
    const moved = folder ? null : this.rows.find((r) => r.kind === "file" && r.file.path === was.path);
    const wanted = (r) => (folder ? r.kind !== "header" : r.kind === "file");
    const near = this.rows.slice(Math.max(0, index)).find(wanted) ?? this.rows.findLast(wanted);
    this.select(moved ?? near ?? null);
  }

  select(row) {
    this.selected = spotOf(row);
  }

  isSelected(row) {
    return isAt(row, this.selected);
  }

  files() {
    return this.status?.sections.reduce((n, s) => n + s.files.length, 0) ?? 0;
  }

  // {add, del} over the files shown (lineTotals).
  totals() {
    return lineTotals(this.status?.sections);
  }

  index(row) {
    return row ? this.rows.findIndex((r) => r.key === row.key) : -1;
  }

  selectedIndex() {
    return this.rows.findIndex((r) => isAt(r, this.selected));
  }

  row() {
    return this.rows.find((r) => isAt(r, this.selected)) ?? null;
  }

  // What the diff pane shows for this list: the selected file, else the
  // first one (null: no files).
  shownFile() {
    const row = this.row();
    return row?.kind === "file" ? row : this.rows.find((r) => r.kind === "file") ?? null;
  }

  // The selected folder (tree mode) is gone from the rows (flat): the
  // first file under it in its section.
  selectIntoFolder() {
    const s = this.selected;
    if (!s?.path.endsWith("/") || this.row()) return;
    this.select(this.rows.find((r) => r.kind === "file" && r.section.id === s.section && r.file.path.startsWith(s.path)) ?? null);
  }

  // The files a row stands for: a header's or a folder's, as listed.
  filesOf(row) {
    if (row.kind === "file") return [row.file.path];
    const files = row.section.files.map((f) => f.path);
    return row.kind === "dir" ? files.filter((p) => p.startsWith(row.path)) : files;
  }
  // The row a script names: a file path, "folder/", "section:<id>", or
  // "in:<section>:<path or folder/>" for the one in that section.
  find(what) {
    if (what.startsWith("in:")) {
      const [, id, ...rest] = what.split(":");
      const path = rest.join(":");
      return this.rows.find((r) => r.section.id === id && (r.kind === "dir" ? r.path === path : r.kind === "file" && r.file.path === path)) ?? null;
    }
    if (what.startsWith("section:")) return this.rows.find((r) => r.kind === "header" && r.section.id === what.slice(8)) ?? null;
    if (what.endsWith("/")) return this.rows.find((r) => r.kind === "dir" && r.path === what) ?? null;
    return this.rows.find((r) => r.kind === "file" && r.file.path === what) ?? null;
  }

  // A file row, unfolding the folders above it in tree mode, and its
  // section when folded. `keepFolds`: a section that's folded stays so: the
  // file is there (its row, as it would show), just not shown.
  findFile(path, section, { keepFolds = false } = {}) {
    const match = (r) => r.kind === "file" && r.file.path === path && (!section || r.section.id === section);
    let row = this.rows.find(match);
    if (!row) {
      const hidden = listRows(this.status, { tree: this.tree }).find(match);
      if (!hidden) return null;
      if (keepFolds && this.folded.has(hidden.section.id)) return hidden;
      if (this.tree) for (const d of parentDirs(hidden)) this.collapsed.delete(d);
      this.folded.delete(hidden.section.id);
      this.rebuild(this.tree);
      row = this.rows.find(match);
    }
    return row ?? null;
  }

  // The next/previous selectable row (folders count, headers don't; rows
  // of a folded section don't show, so they're skipped).
  step(delta) {
    const rows = this.rows.filter((r) => r.kind !== "header");
    if (!rows.length) return null;
    const at = rows.findIndex((r) => isAt(r, this.selected));
    if (at >= 0) return rows[Math.min(rows.length - 1, Math.max(0, at + delta))];
    // Not shown: a folded section hides it. On from where it sits.
    const all = this.order.filter((r) => r.kind !== "header");
    const was = all.findIndex((r) => isAt(r, this.selected));
    if (was < 0) return rows[delta > 0 ? 0 : rows.length - 1];
    const shown = new Set(rows.map((r) => r.key));
    const next = delta > 0 ? all.slice(was + 1).find((r) => shown.has(r.key)) : all.slice(0, was).findLast((r) => shown.has(r.key));
    return next ? rows.find((r) => r.key === next.key) : rows[delta > 0 ? rows.length - 1 : 0];
  }

  edge(last) {
    const rows = this.rows.filter((r) => r.kind !== "header");
    return rows.length ? rows[last ? rows.length - 1 : 0] : null;
  }

  toggleFold(row) {
    if (row.collapsed) this.collapsed.delete(row.key);
    else this.collapsed.add(row.key);
    this.rebuild(this.tree);
  }

  // The folder a row sits in (tree mode).
  parent(row) {
    const at = this.rows.indexOf(row);
    for (let i = at - 1; i >= 0; i--) if (this.rows[i].kind === "dir" && this.rows[i].depth < row.depth) return this.rows[i];
    return null;
  }

  // What the diff pane shows for a file row.
  viewFor(row, line = null) {
    return { ...viewOf(entryOf(row), this.where), line };
  }

  // The file `delta` files on from the view's (J/K: the order the list
  // shows, folded folders too), or null past the ends.
  stepFile(view, delta) {
    const order = fileOrder(this.status, this.tree);
    const at = order.findIndex((r) => r.file.path === view.path && r.section.id === view.section);
    const next = at >= 0 ? order[at + delta] : null;
    return next ? this.findFile(next.file.path, next.section.id) : null; // (a folded section opens)
  }
}
