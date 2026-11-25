// The Committed view (merge-base → HEAD): its file list (committed.js), what
// it tells the diff pane (model.js), and its base (the engine's default, or the picked one).
// The engine's own half is in tests/appjson.rs; the last test here runs the
// built binary when there is one (target/release or target/debug).
import "./stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdtempSync, writeFileSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
const { rangeOf, filesArgs, committedStatus } = await import("../mods/gitview/committed.js");
const { entryOf, viewOf, diffArgs, sameShown, listRows } = await import("../mods/gitview/model.js");
const { resolveBase, baseArgs, carries } = await import("../mods/gitview/bases.js");

const MB = "a".repeat(40);
const HEAD = "b".repeat(40);
const status = (over = {}) => ({ root: "/r", branch: "feature", head: HEAD, scope: "branch", base: { label: "main", merge_base: MB }, sections: [{ id: "branch", title: "", files: [] }], ...over });

// ---- the list ----------------------------------------------------------------

test("the range is merge-base → HEAD; none when HEAD is the merge-base or there is no HEAD", () => {
  assert.deepEqual(rangeOf(status()), { mb: MB, head: HEAD });
  assert.equal(rangeOf(status({ head: MB })), null); // on the base itself, or nothing committed yet
  assert.equal(rangeOf(status({ head: null })), null); // before the first commit
  assert.equal(rangeOf(status({ base: null })), null);
});

test("commit-files is asked for \"<merge-base>..<HEAD>\", on the machine when remote", () => {
  const r = rangeOf(status());
  assert.deepEqual(filesArgs(status(), r, null), ["commit-files", "--repo", "/r", "--root", "--sha", `${MB}..${HEAD}`]);
  assert.deepEqual(filesArgs(status(), r, "box").slice(-2), ["--on", "box"]);
});

test("the status of the list: one COMMITTED section, each file's rev is HEAD; no files, no section", () => {
  const files = [{ path: "a.txt", orig: null, kind: "added", letter: "A", add: 1, del: 0 }, { path: "n.txt", orig: "o.txt", kind: "renamed", letter: "R", add: 1, del: 1 }];
  const s = committedStatus(status(), files);
  assert.equal(s.scope, "committed");
  assert.deepEqual(s.sections.map((x) => [x.id, x.title, x.cached, x.files.length]), [["committed", "COMMITTED", false, 2]]);
  assert.deepEqual(s.sections[0].files.map((f) => f.rev), [HEAD, HEAD]);
  assert.deepEqual([s.root, s.branch, s.head, s.base.label], ["/r", "feature", HEAD, "main"]);
  // A header row for the section (it folds), then the files.
  assert.deepEqual(listRows(s).map((r) => r.kind), ["header", "file", "file"]);
  const none = committedStatus(status({ head: MB }), undefined);
  assert.deepEqual(none.sections, []);
  assert.deepEqual(listRows(none), []);
});

// ---- what the diff pane is told ------------------------------------------------

const where = { root: "/r", on: null, base: { label: "origin/main", merge_base: MB } };
const rowOf = (f, id = "committed") => ({ file: f, section: { id, cached: false } });
const file = { path: "src/a.js", orig: "src/b.js", kind: "renamed", letter: "R", add: 3, del: 1, rev: HEAD };

test("a committed file's view: the base, HEAD as the new side, and the header's scope says what is compared", () => {
  const v = viewOf(entryOf(rowOf(file)), where);
  assert.equal(v.scope, "committed vs origin/main");
  assert.deepEqual([v.section, v.to, v.base.merge_base, v.cached], ["committed", "head", MB, false]);
  assert.deepEqual(diffArgs(v, { dark: true, unfold: false }), ["diff", "--repo", "/r", "--root", "--path", "src/a.js", "--kind", "renamed", "--theme", "dark", "--orig", "src/b.js", "--merge-base", MB, "--base", "origin/main", "--to", "head", "--head", HEAD]);
  // The sha is the one the list was built from (the file's rev), not "HEAD".
  assert.equal(v.head, HEAD);
  const moved = viewOf(entryOf(rowOf({ ...file, rev: MB })), where);
  assert.equal(diffArgs(moved, { dark: true, unfold: false }).at(-1), MB);
  // No rev (no sha known): `--to head` alone, the engine's live HEAD.
  assert.equal(diffArgs(viewOf(entryOf(rowOf({ ...file, rev: null })), where), { dark: true, unfold: false }).includes("--head"), false);
});

test("the Branch view's and the working tree's diff calls are what they were: no --to", () => {
  const branch = viewOf(entryOf(rowOf({ ...file, orig: null, kind: "modified", rev: "r1" }, "branch")), where);
  assert.equal(branch.scope, "vs origin/main");
  assert.equal(branch.to, null);
  assert.equal(branch.head, null);
  assert.equal(diffArgs(branch, { dark: true, unfold: false }).includes("--head"), false);
  const args = diffArgs(branch, { dark: false, unfold: true, unless: "h" });
  assert.deepEqual(args, ["diff", "--repo", "/r", "--root", "--path", "src/a.js", "--kind", "modified", "--theme", "light", "--merge-base", MB, "--base", "origin/main", "--unfold", "--unless", "h"]);
  const work = viewOf(entryOf({ file, section: { id: "changes", cached: false } }), where);
  assert.equal(work.base, null);
  assert.equal(diffArgs(work, { dark: true, unfold: false }).includes("--to"), false);
});

test("the pane reloads when HEAD, the merge-base or the base's label changes; not when nothing did", () => {
  const a = viewOf(entryOf(rowOf(file)), where);
  assert.equal(sameShown(a, viewOf(entryOf(rowOf(file)), where)), true);
  assert.equal(sameShown(a, viewOf(entryOf(rowOf({ ...file, rev: "c".repeat(40) })), where)), false); // HEAD moved
  assert.equal(sameShown(a, viewOf(entryOf(rowOf(file)), { ...where, base: { ...where.base, merge_base: "d".repeat(40) } })), false);
  // The same file in the Branch view is another diff.
  assert.equal(sameShown(a, viewOf(entryOf(rowOf(file, "branch")), where)), false);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "gv-committed-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  writeFileSync(join(dir, "a"), "a");
  git("add", "a");
  git("commit", "-q", "-m", "a");
  const run = async (args) => {
    try {
      return { code: 0, stdout: git(...args), stderr: "" };
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "") };
    }
  };
  return { dir, git, run };
}

// ---- the real engine ---------------------------------------------------------------

const here = dirname(fileURLToPath(import.meta.url));
const BIN = ["../../target/release/herdr-gitview", "../../target/debug/herdr-gitview"].map((p) => join(here, p)).find(existsSync);

test("the file list from the real engine matches `git diff --numstat -M <merge-base> HEAD`", { skip: !BIN && "no built herdr-gitview" }, async () => {
  const r = repo();
  const w = (name, text) => { mkdirSync(dirname(join(r.dir, name)), { recursive: true }); writeFileSync(join(r.dir, name), text); };
  w("old.txt", "1\n2\n3\n4\n5\n6\n7\n8\n");
  w("gone.txt", "bye\n");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "base");
  r.git("switch", "-q", "-c", "feature", "HEAD");
  w("a", "a\nb\n");
  w("dir/new.txt", "x\ny\n");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "one");
  r.git("rm", "-q", "gone.txt");
  r.git("mv", "old.txt", "moved.txt");
  w("moved.txt", "1\n2\n3\n4\n5\n6\n7\nEIGHT\n");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "two");
  w("a", "uncommitted\n"); // not in the list
  const run = (args) => JSON.parse(execFileSync(BIN, ["json", ...args], { encoding: "utf8", env: { ...process.env, GITVIEW_CONFIG_DIR: join(r.dir, ".git/none") } }));
  const st = run(["status", "--repo", r.dir, "--scope", "branch"]);
  const range = rangeOf(st);
  const listed = committedStatus(st, run(filesArgs(st, range, null)).files);
  const got = listed.sections[0].files.map((f) => [f.path, f.orig, f.letter, f.add, f.del]).sort();
  const numstat = r.git("diff", "--numstat", "-M", range.mb, "HEAD").split("\n").map((l) => l.split("\t")).map(([add, del, p]) => [p, +add, +del]);
  // numstat prints a rename as "old => new" (with braces when a folder is shared).
  const names = r.git("diff", "--name-status", "-M", range.mb, "HEAD").split("\n").map((l) => l.split("\t"));
  assert.deepEqual(got.map((f) => f[0]), names.map((n) => n.at(-1)).sort());
  assert.equal(got.find((f) => f[0] === "moved.txt")[1], "old.txt");
  assert.deepEqual(got.map((f) => [f[3], f[4]]).sort(), numstat.map((n) => [n[1], n[2]]).sort());
  assert.deepEqual(got.find((f) => f[0] === "a").slice(3), [2, 1]); // the committed lines (the no-newline "a" is rewritten), not the uncommitted edit
});

test("the Committed view's base is the engine's default with no pick, and the pick when there is one", { skip: !BIN && "no built herdr-gitview" }, async () => {
  const r = repo();
  r.git("switch", "-q", "-c", "feature", "HEAD");
  writeFileSync(join(r.dir, "one"), "1\n");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "one");
  r.git("tag", "mid"); // a picked base (a tag, so the engine's own choice stays main): the first commit
  writeFileSync(join(r.dir, "two"), "2\n");
  r.git("add", ".");
  r.git("commit", "-q", "-m", "two");
  const run = (args) => JSON.parse(execFileSync(BIN, ["json", ...args], { encoding: "utf8", env: { ...process.env, GITVIEW_CONFIG_DIR: join(r.dir, ".git/none") } }));
  const filesOf = (st) => committedStatus(st, run(filesArgs(st, rangeOf(st), null)).files).sections[0].files.map((f) => f.path).sort();
  // No pick: the engine's own base (main), so both commits.
  const dflt = run(["status", "--repo", r.dir, "--scope", "branch"]);
  assert.equal(dflt.base.label, "main");
  assert.equal(rangeOf(dflt).mb, r.git("rev-parse", "main"));
  assert.deepEqual(filesOf(dflt), ["one", "two"]);
  // A pick (mid): its merge-base with HEAD, so the last commit only.
  const res = await resolveBase(r.run, "mid");
  assert.equal(res.ok, true);
  const picked = run(["status", "--repo", r.dir, "--scope", "branch", ...baseArgs("mid", res)]);
  assert.equal(carries(picked, res), true);
  assert.equal(picked.base.label, "mid");
  assert.equal(rangeOf(picked).mb, r.git("rev-parse", "mid"));
  assert.deepEqual(filesOf(picked), ["two"]);
});
