// The Committed view (merge-base → HEAD): its file list (committed.js), what
// it tells the diff pane (model.js), and the pull request's base (pr.js).
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
const { parsePr, parseRepoUrl, sameRepo, remotesFor, prRef, lookupPr, ghFinder, PrCache, prMark, PR_ARGS, PR_ARGS_OLD } = await import("../mods/gitview/pr.js");

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

// ---- the pull request ------------------------------------------------------------

const gh = (over = {}) => JSON.stringify({ number: 12, baseRefName: "develop", headRefOid: HEAD, state: "OPEN", url: "https://github.com/acme/app/pull/12", ...over });

test("gh's reply: an open PR gives its number, base and head; anything else gives none", () => {
  assert.deepEqual(parsePr(gh()), { number: 12, base: "develop", headOid: HEAD, url: "https://github.com/acme/app/pull/12" });
  assert.equal(parsePr(gh({ state: "MERGED" })), null);
  assert.equal(parsePr(gh({ state: "CLOSED" })), null);
  assert.equal(parsePr("no pull requests found for branch"), null);
  assert.equal(parsePr(""), null);
  assert.equal(parsePr(gh({ number: "12" })), null);
  assert.equal(parsePr(gh({ baseRefName: "--output=x" })), null); // never an option for git
  assert.equal(parsePr(gh({ baseRefName: "a..b" })), null);
  assert.equal(parsePr(gh({ baseRefName: "has space" })), null);
  assert.equal(parsePr(gh({ headRefOid: "zz" })).headOid, null);
  assert.deepEqual(PR_ARGS, ["pr", "view", "--json", "number,baseRefName,headRefOid,state,url"]);
});

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "gv-pr-"));
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

test("repo URLs: https, ssh and scp forms, with or without .git, are the same repo; hosts and names are told apart", () => {
  const same = ["https://github.com/acme/app", "https://github.com/acme/app.git", "https://github.com/acme/app/", "https://user@github.com/Acme/App.git", "git@github.com:acme/app.git", "git@github.com:acme/app", "ssh://git@github.com/acme/app.git", "ssh://git@github.com:22/acme/app.git", "git://github.com/acme/app.git", "ssh://git@ssh.github.com:443/acme/app.git", "https://www.github.com/acme/app"];
  for (const u of same) assert.deepEqual(parseRepoUrl(u), { host: "github.com", path: "acme/app" }, u);
  // A PR's url names the base repository, then `/pull/<n>`.
  for (const u of same) assert.equal(sameRepo("https://github.com/acme/app/pull/12", u), true, u);
  assert.equal(sameRepo("https://github.com/acme/app/pull/12", "git@github.com:me/app.git"), false); // the fork
  assert.equal(sameRepo("https://github.com/acme/app/pull/12", "git@github.com:acme/app-tools.git"), false);
  assert.equal(sameRepo("https://github.com/acme/app/pull/12", "git@ghe.example.com:acme/app.git"), false);
  assert.equal(sameRepo("https://ghe.example.com:8443/acme/app/pull/3", "git@ghe.example.com:acme/app.git"), true);
  for (const bad of ["", null, "origin", "/local/path/app.git", "../app", "https://github.com/acme"]) assert.equal(parseRepoUrl(bad), null, String(bad));
  assert.equal(sameRepo("", "git@github.com:acme/app.git"), false);
  assert.equal(sameRepo("https://github.com/acme/app/pull/12", ""), false);
});

const PR_URL = "https://github.com/acme/app/pull/12";

test("the PR's base ref: <remote>/<base> of the remote that is the PR's base repository, else none", async () => {
  const r = repo();
  r.git("branch", "develop"); // a local branch alone is not the PR's base
  r.git("remote", "add", "origin", "https://github.com/acme/app.git");
  assert.equal(await prRef(r.run, "develop", PR_URL), null);
  r.git("update-ref", "refs/remotes/origin/develop", "HEAD");
  assert.equal(await prRef(r.run, "develop", PR_URL), "origin/develop");
  assert.equal(await prRef(r.run, "gone", PR_URL), null);
  assert.deepEqual(await remotesFor(r.run, PR_URL), ["origin"]);
});

test("a fork workflow: origin is the fork, upstream the PR's base repository: upstream/<base> is used; no matching remote: none", async () => {
  const r = repo();
  r.git("remote", "add", "origin", "git@github.com:me/app.git");
  r.git("remote", "add", "upstream", "https://github.com/acme/app.git");
  r.git("update-ref", "refs/remotes/origin/develop", "HEAD"); // the fork's stale branch
  assert.equal(await prRef(r.run, "develop", PR_URL), null); // the base repository's is not fetched
  r.git("update-ref", "refs/remotes/upstream/develop", "HEAD");
  assert.equal(await prRef(r.run, "develop", PR_URL), "upstream/develop");
  // Two remotes of the same repository: origin first.
  r.git("remote", "add", "mirror", "git@github.com:acme/app.git");
  r.git("update-ref", "refs/remotes/mirror/develop", "HEAD");
  assert.deepEqual(await remotesFor(r.run, PR_URL), ["upstream", "mirror"]);
  // No remote is the base repository (a PR of another repo, or no remote at all).
  assert.equal(await prRef(r.run, "develop", "https://github.com/other/thing/pull/1"), null);
  assert.equal(await prRef(repo().run, "develop", PR_URL), null);
  // git's own rewrite of URLs is followed.
  const i = repo();
  i.git("remote", "add", "origin", "gh:acme/app");
  i.git("config", "url.https://github.com/.insteadOf", "gh:");
  i.git("update-ref", "refs/remotes/origin/develop", "HEAD");
  assert.equal(await prRef(i.run, "develop", PR_URL), "origin/develop");
});

test("lookupPr: the PR with its ref; no gh, a failing gh, a base that is no ref here or in no remote: none, no throw", async () => {
  const r = repo();
  r.git("remote", "add", "origin", "https://github.com/acme/app.git");
  r.git("update-ref", "refs/remotes/origin/develop", "HEAD");
  const ok = async () => ({ code: 0, stdout: gh() });
  assert.deepEqual(await lookupPr(ok, r.run), { number: 12, base: "develop", headOid: HEAD, url: PR_URL, ref: "origin/develop" });
  // An old gh refuses `headRefOid`: asked again without it (no head to compare).
  // It has no base repository field either: the url answers.
  const old = async (args) => (args.join(",").includes("headRefOid") ? { code: 1, stdout: "", stderr: 'Unknown JSON field: "headRefOid"' } : { code: 0, stdout: gh({ headRefOid: undefined }) });
  const got = await lookupPr(old, r.run);
  assert.deepEqual([got.number, got.ref, got.headOid], [12, "origin/develop", null]);
  assert.deepEqual(PR_ARGS_OLD.includes("headRefOid"), false);
  assert.equal(await lookupPr(async () => { throw new Error("gh: not installed"); }, r.run), null);
  assert.equal(await lookupPr(async () => ({ code: 1, stdout: "", stderr: "not logged in" }), r.run), null);
  assert.equal(await lookupPr(async () => ({ code: 0, stdout: gh({ baseRefName: "nowhere" }) }), r.run), null);
  assert.equal(await lookupPr(async () => ({ code: 0, stdout: gh({ url: "https://github.com/other/thing/pull/12" }) }), r.run), null); // its repository is no remote
  assert.equal(await lookupPr(async () => ({ code: 0, stdout: gh({ url: undefined }) }), r.run), null); // its repository is not known
  assert.equal(await lookupPr(ok, async () => { throw new Error("git is gone"); }), null);
});

test("gh is found once: the bare name, else Homebrew's places; none at all is none", async () => {
  const tried = [];
  const run = (present) => async (cmd) => {
    tried.push(cmd);
    if (!present.includes(cmd)) throw new Error(`spawn ${cmd} ENOENT`);
    return { code: 0 };
  };
  let find = ghFinder(run(["gh", "/opt/homebrew/bin/gh"]));
  assert.equal(await find(), "gh");
  assert.deepEqual(tried, ["gh"]);
  tried.length = 0;
  find = ghFinder(run(["/opt/homebrew/bin/gh"]));
  assert.equal(await find(), "/opt/homebrew/bin/gh");
  assert.equal(await find(), "/opt/homebrew/bin/gh");
  assert.deepEqual(tried, ["gh", "/opt/homebrew/bin/gh"]); // once
  find = ghFinder(run(["/usr/local/bin/gh"]));
  assert.equal(await find(), "/usr/local/bin/gh");
  tried.length = 0;
  find = ghFinder(async (cmd) => { tried.push(cmd); return { code: 127 }; });
  assert.equal(await find(), null);
  assert.equal(await find(), null);
  assert.equal(tried.length, 3); // asked once, "none" is kept
});

test("the PR cache: asked again for a new HEAD, another branch or after the minutes; a branch's PR answers meanwhile", () => {
  const c = new PrCache(1000);
  const pr = { number: 12, ref: "origin/develop" };
  assert.equal(c.due("k", "h1", "feature", 0), true); // nothing known
  c.set("k", { pr, head: "h1", branch: "feature", at: 0 });
  assert.equal(c.due("k", "h1", "feature", 999), false);
  assert.equal(c.due("k", "h1", "feature", 1000), true); // old
  assert.equal(c.due("k", "h2", "feature", 10), true); // HEAD moved
  assert.equal(c.get("k", "h2", "feature"), pr); // …and the old answer holds until the new one is in
  assert.equal(c.due("k", "h1", "other", 10), true);
  // "No PR" is an answer too: not asked again at once.
  c.set("k", { pr: null, head: "h1", branch: "other", at: 0 });
  assert.equal(c.due("k", "h1", "other", 10), false);
  assert.equal(c.get("k", "h1", "other"), null);
});

test("a cached PR is never used for another branch, nor on no branch for another HEAD", () => {
  const c = new PrCache();
  const pr = { number: 12, ref: "origin/develop" };
  c.set("k", { pr, head: "h1", branch: "feature" });
  assert.equal(c.get("k", "h1", "feature"), pr);
  // After a checkout the cache still holds the old branch's PR: not this one's.
  assert.equal(c.get("k", "h9", "other"), null);
  assert.equal(c.get("k", "h1", "other"), null);
  assert.equal(c.get("k", "h1", null), null); // detached
  // Detached: only that HEAD.
  c.set("k", { pr, head: "h1", branch: null });
  assert.equal(c.get("k", "h1", null), pr);
  assert.equal(c.get("k", "h2", null), null);
  assert.equal(c.get("k", "h1", "feature"), null);
  // The status that tells the branch (a status can't know it before) may try the cached PR…
  assert.equal(c.tentative("k"), pr);
  // …and drops it when the branch it tells is not the PR's.
  c.drop("k");
  assert.equal(c.tentative("k"), null);
});

test("the list reloads when the PR's answer is not the base the shown list used, also after a checkout", () => {
  const c = new PrCache();
  const pr = { number: 12, ref: "origin/develop" };
  const shown = (over = {}) => ({ branch: "feature", head: "h1", pr_base: null, ...over });
  // The list was built with no PR; the PR appears.
  c.set("k", { pr, head: "h1", branch: "feature" });
  assert.equal(c.changes("k", shown()), true);
  assert.equal(c.changes("k", shown({ pr_base: "origin/develop" })), false);
  // The base moved.
  c.set("k", { pr: { number: 12, ref: "origin/release" }, head: "h1", branch: "feature" });
  assert.equal(c.changes("k", shown({ pr_base: "origin/develop" })), true);
  // The PR went.
  c.set("k", { pr: null, head: "h1", branch: "feature" });
  assert.equal(c.changes("k", shown({ pr_base: "origin/develop" })), true);
  // The checkout case: the list was built on the old branch's PR base and the
  // new branch has no PR. (Comparing with the cache's entry from before the
  // answer, as it was, gave null !== null: no reload, the old base stayed.)
  c.set("k", { pr: null, head: "h2", branch: "other" });
  assert.equal(c.changes("k", shown({ branch: "other", head: "h2", pr_base: "origin/develop" })), true);
  assert.equal(c.changes("k", shown({ branch: "other", head: "h2", pr_base: null })), false);
  // A shown list of another branch than the entry's: the entry says nothing for it.
  assert.equal(c.changes("k", shown({ branch: "feature", pr_base: "origin/develop" })), true);
});

test("a PR base the list can't compare against is left alone until the branch changes", () => {
  const c = new PrCache();
  c.set("k", { pr: { number: 1, ref: "origin/x" }, head: "h", branch: "f" });
  c.markBroken("k", "origin/x");
  assert.equal(c.get("k", "h", "f"), null);
  assert.equal(c.tentative("k"), null);
  c.set("k", { pr: { number: 1, ref: "origin/x" }, head: "h2", branch: "f" }); // asked again, same answer
  assert.equal(c.get("k", "h2", "f"), null);
  c.set("k", { pr: { number: 1, ref: "origin/x" }, head: "h", branch: "g" });
  assert.equal(c.get("k", "h", "g")?.number, 1);
});

test("the header's mark: the number, and \"unpushed\" when HEAD is not the PR's head", () => {
  const pr = { number: 12, ref: "origin/develop", headOid: HEAD };
  assert.deepEqual(prMark(pr, HEAD), { number: 12, unpushed: false });
  assert.deepEqual(prMark(pr, "c".repeat(40)), { number: 12, unpushed: true });
  assert.deepEqual(prMark({ ...pr, headOid: null }, HEAD), { number: 12, unpushed: false }); // no claim
  assert.equal(prMark(null, HEAD), null);
});

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
