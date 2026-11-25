// The views table (views.js) and the Branch view's base (bases.js): what the
// picker lists, and how a picked ref becomes the engine's arguments, run on a
// real throwaway repo for the merge-base and the HEAD that moves.
import "./stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
const { VIEWS, DEFAULT_VIEW, viewById, nextView, toggleLabel, emptyText } = await import("../mods/gitview/views.js");
const { parseRefs, parseLog, baseOptions, filterOptions, isCurrent, pickOf, resolveBase, baseArgs, carries, loadLists } = await import("../mods/gitview/bases.js");

test("the views: Uncommitted (the default) is the work tree's; Branch and Committed are against a base", () => {
  assert.deepEqual(VIEWS.map((v) => v.id), ["uncommitted", "branch", "committed"]);
  assert.equal(DEFAULT_VIEW, "uncommitted");
  assert.deepEqual(VIEWS.map((v) => [v.scope, v.actsOnWork, v.usesBase, v.to]), [["worktree", true, false, null], ["branch", false, true, null], ["branch", false, true, "head"]]);
  assert.equal(viewById("nonsense").id, "uncommitted");
});

test("w goes to the next view and round again; its label names every view", () => {
  assert.equal(nextView("uncommitted").id, "branch");
  assert.equal(nextView("branch").id, "committed");
  assert.equal(nextView("committed").id, "uncommitted");
  assert.equal(toggleLabel(), "uncommitted / branch / committed");
});

test("the empty text: Committed says HEAD is the merge-base, the others keep theirs", () => {
  assert.equal(emptyText(viewById("branch"), "main"), "No changes");
  assert.match(emptyText(viewById("committed"), "origin/main"), /^Nothing committed yet: HEAD is the merge-base with origin\/main/);
  assert.match(emptyText(viewById("committed")), /with the base/);
});

const REFS = [
  "refs/tags/v1.0\taaaaaaa\trelease one",
  "refs/remotes/origin/HEAD\tbbbbbbb\tmain",
  "refs/remotes/origin/main\tbbbbbbb\tmain subject",
  "refs/heads/feature/x\tccccccc\twork\twith tab",
  "refs/heads/main\tbbbbbbb\tmain subject",
  "refs/notes/commits\tddddddd\tnotes",
  "",
].join("\n");

test("refs: branches, then remote branches, then tags; a remote's HEAD and other refs are left out", () => {
  const refs = parseRefs(REFS);
  assert.deepEqual(refs.map((r) => [r.kind, r.label]), [["branch", "feature/x"], ["branch", "main"], ["remote", "origin/main"], ["tag", "v1.0"]]);
  assert.equal(refs[0].ref, "refs/heads/feature/x");
  assert.equal(refs[0].detail, "ccccccc work\twith tab");
});

test("a kind is cut at its cap, the newest kept", () => {
  const many = Array.from({ length: 150 }, (_, i) => `refs/tags/t${i}\t1234567\ts`).join("\n");
  const tags = parseRefs(many);
  assert.equal(tags.length, 100);
  assert.equal(tags[0].label, "t0");
});

test("commits: the short sha is the label, the subject the detail; a bad line is skipped", () => {
  const sha = "a".repeat(40);
  const commits = parseLog(`${sha}\taaaaaaa\tfix the thing\nnot a sha\tx\ty\n${"b".repeat(40)}\tbbbbbbb\t\n`);
  assert.deepEqual(commits.map((c) => [c.kind, c.ref === sha || c.ref.startsWith("b"), c.label, c.detail]), [["commit", true, "aaaaaaa", "fix the thing"], ["commit", true, "bbbbbbb", "(no message)"]]);
});

test("the picker's rows: the default first, then branches, remotes, tags, commits", () => {
  const options = baseOptions({ defaultLabel: "origin/master", refs: parseRefs(REFS), commits: parseLog(`${"a".repeat(40)}\taaaaaaa\ts`) });
  assert.deepEqual(options.map((o) => o.kind), ["default", "branch", "branch", "remote", "tag", "commit"]);
  assert.equal(options[0].label, "origin/master");
  assert.equal(baseOptions({})[0].label, "default"); // not known yet
});

test("the default row is the current one with no pick and clears the pick; a hand-picked ref is current on its own row", () => {
  const options = baseOptions({ defaultLabel: "origin/main", refs: parseRefs(REFS) });
  assert.equal(pickOf(options[0]), null);
  assert.equal(isCurrent(options[0], null), true);
  assert.equal(isCurrent(options[0], { ref: "refs/heads/main", label: "main" }), false);
  const main = options.find((o) => o.label === "main");
  assert.equal(isCurrent(main, { ref: "refs/heads/main", label: "main" }), true);
});

test("a search keeps rows with every word in the kind, label or detail", () => {
  const options = baseOptions({ defaultLabel: "origin/main", refs: parseRefs(REFS) });
  assert.deepEqual(filterOptions(options, "feat").map((o) => o.label), ["feature/x"]);
  assert.deepEqual(filterOptions(options, "MAIN subject").map((o) => o.label), ["main", "origin/main"]);
  assert.deepEqual(filterOptions(options, "tag v1").map((o) => o.label), ["v1.0"]);
  assert.equal(filterOptions(options, "  ").length, options.length);
  assert.deepEqual(filterOptions(options, "zzz"), []);
});

test("the current row: the stored ref's, or the default's when there is none; the default clears the pick", () => {
  const options = baseOptions({ refs: parseRefs(REFS) });
  const main = options.find((o) => o.label === "main");
  assert.equal(isCurrent(main, { ref: "refs/heads/main", label: "main" }), true);
  assert.equal(isCurrent(options[0], { ref: "refs/heads/main", label: "main" }), false);
  assert.equal(isCurrent(options[0], null), true);
  assert.equal(isCurrent(main, null), false);
  assert.equal(pickOf(options[0]), null);
  assert.deepEqual(pickOf(main), { ref: "refs/heads/main", label: "main" });
});

// ---- a real repo --------------------------------------------------------------

function repo() {
  const dir = mkdtempSync(join(tmpdir(), "gv-bases-"));
  const git = (...args) => execFileSync("git", ["-c", "user.name=t", "-c", "user.email=t@t", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" }).trim();
  git("init", "-q", "-b", "main");
  const commit = (name) => {
    writeFileSync(join(dir, name), name);
    git("add", name);
    git("commit", "-q", "-m", `add ${name}`);
    return git("rev-parse", "HEAD");
  };
  // The runner the mod gives bases.js: {code, stdout, stderr}, a git that fails is a result.
  const run = async (args) => {
    try {
      return { code: 0, stdout: git(...args), stderr: "" };
    } catch (e) {
      return { code: e.status ?? 1, stdout: String(e.stdout ?? "").trim(), stderr: String(e.stderr ?? "") };
    }
  };
  return { dir, git, commit, run };
}

test("the lists come from git: refs and the commits of HEAD", async () => {
  const r = repo();
  r.commit("a");
  r.git("tag", "v1");
  r.git("branch", "other");
  const { refs, commits } = await loadLists(r.run);
  assert.deepEqual(refs.map((x) => [x.kind, x.label]).sort(), [["branch", "main"], ["branch", "other"], ["tag", "v1"]]);
  assert.equal(commits.length, 1);
  assert.equal(commits[0].detail, "add a");
});

test("a picked ref: its merge-base with HEAD, and HEAD, for status's --base --merge-base --head", async () => {
  const r = repo();
  const first = r.commit("a");
  r.git("switch", "-q", "-c", "topic");
  const head = r.commit("b");
  const got = await resolveBase(r.run, "refs/heads/main");
  assert.deepEqual({ ok: got.ok, head: got.head, mb: got.mb }, { ok: true, head, mb: first });
  assert.deepEqual(baseArgs("main", got), ["--base", "main", "--merge-base", first, "--head", head]);
  // The engine takes the base only when it carries it; HEAD having moved is not an error there.
  assert.equal(carries({ head, base: { label: "main", merge_base: first } }, got), true);
  assert.equal(carries({ head, base: { label: "origin/main", merge_base: "f".repeat(40) } }, got), false);
  assert.equal(carries({ head: "e".repeat(40), base: { label: "main", merge_base: first } }, got), false);
});

test("HEAD moves: the merge-base is found again (a rebase onto a new tip), and is kept while nothing moved", async () => {
  const r = repo();
  const first = r.commit("a");
  r.git("switch", "-q", "-c", "topic");
  r.commit("b");
  const one = await resolveBase(r.run, "refs/heads/main");
  assert.equal(one.mb, first);
  // Nothing moved: the cache answers (and git is asked once: rev-parse).
  let calls = 0;
  const counting = (args) => (calls++, r.run(args));
  assert.deepEqual(await resolveBase(counting, "refs/heads/main", one), one);
  assert.equal(calls, 1);
  // main moves on, topic merges it: HEAD is new and so is the merge-base.
  r.git("switch", "-q", "main");
  const tip = r.commit("c");
  r.git("switch", "-q", "topic");
  r.git("merge", "-q", "--no-edit", "main");
  const two = await resolveBase(r.run, "refs/heads/main", one);
  assert.equal(two.ok, true);
  assert.notEqual(two.head, one.head);
  assert.equal(two.mb, tip);
  // The ref's own tip moving alone also asks again.
  r.git("switch", "-q", "main");
  const tip2 = r.commit("d");
  r.git("switch", "-q", "topic");
  const three = await resolveBase(r.run, "refs/heads/main", two);
  assert.equal(three.tip, tip2);
  assert.equal(three.mb, tip);
});

test("a ref that is gone, one that isn't a commit, or no ref: no base, never a made-up one", async () => {
  const r = repo();
  r.commit("a");
  assert.equal((await resolveBase(r.run, "refs/heads/nope")).ok, false);
  assert.equal((await resolveBase(r.run, "--output=/tmp/x")).ok, false);
  assert.equal((await resolveBase(r.run, null)).ok, false);
  assert.match((await resolveBase(r.run, "refs/heads/nope")).why, /not a commit/);
});

test("histories with nothing in common have no merge-base", async () => {
  const r = repo();
  r.commit("a");
  r.git("switch", "-q", "--orphan", "island");
  r.commit("z");
  const got = await resolveBase(r.run, "refs/heads/main");
  assert.equal(got.ok, false);
  assert.match(got.why, /no common history/);
});

test("git that can't run at all rejects: the caller tries again instead of dropping the pick", async () => {
  await assert.rejects(resolveBase(async () => { throw new Error("unreachable"); }, "refs/heads/main"), /unreachable/);
});
