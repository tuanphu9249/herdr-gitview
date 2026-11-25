// The pull request of the branch, for the Committed view: its base branch is
// that view's default base. Asked of `gh` (`gh pr view` in the repo's root),
// never on the list's way: the list loads with what is known, and the answer
// comes later (main.js). No `gh`, not logged in, no PR, a PR that is not open:
// no PR, silently. Pure: git and gh are functions `(args) -> {code, stdout}`.
//
// The base is `<remote>/<baseRefName>` for the remote that is the PR's *base
// repository* (in a fork workflow `origin` is the fork, whose branch of that
// name can be stale). gh 2.2 has no base-repository field, so the PR's `url`
// (https://<host>/<owner>/<repo>/pull/<n>: always the base repository's) is
// compared with the remotes' URLs; a current gh gives the same url. No remote
// is that repository: no PR base.

export const PR_ARGS = ["pr", "view", "--json", "number,baseRefName,headRefOid,state,url"];
// An old gh (2.2) has no `headRefOid` and refuses the whole list: asked again
// without it (no "unpushed" mark then, as the PR's head is not known).
export const PR_ARGS_OLD = ["pr", "view", "--json", "number,baseRefName,state,url"];
// `gh` is asked again for the same HEAD after this long (a PR opened or
// closed meanwhile), and at once when HEAD moved.
export const PR_TTL_MS = 5 * 60 * 1000;
const SHA = /^[0-9a-f]{40,64}$/;
// A branch name git accepts is one the engine can be handed; this keeps out
// what could read as an option or a range.
const BRANCH = /^[^\s~^:?*[\\-][^\s~^:?*[\\]*$/;

// `gh pr view --json …`'s text → {number, base, headOid, url}, or null when
// there is no open PR in it.
export function parsePr(text) {
  let o;
  try {
    o = JSON.parse(String(text ?? ""));
  } catch {
    return null;
  }
  if (!o || o.state !== "OPEN" || !Number.isInteger(o.number) || typeof o.baseRefName !== "string") return null;
  if (!BRANCH.test(o.baseRefName) || o.baseRefName.includes("..")) return null;
  return { number: o.number, base: o.baseRefName, headOid: SHA.test(o.headRefOid ?? "") ? o.headRefOid : null, url: typeof o.url === "string" ? o.url : null };
}

// A git remote's URL or a PR's URL as {host, path} ("owner/repo", lowercase),
// or null. https, ssh://, git:// and scp-like (git@host:owner/repo), with or
// without `.git`, a trailing slash, a user, a port. GitHub's `ssh.` and
// `www.` hosts are github.com.
export function parseRepoUrl(text) {
  const t = String(text ?? "").trim();
  const m = /^[a-z][a-z0-9+.-]*:\/\/(?:[^@/]*@)?([^/:]+)(?::\d+)?\/(.+)$/i.exec(t) ?? /^(?:[^@/\s]+@)?([^:/\s]+):(?!\/\/)(.+)$/.exec(t);
  if (!m) return null;
  const path = m[2].replace(/[?#].*$/, "").replace(/^\/+|\/+$/g, "").replace(/\.git$/i, "");
  const host = m[1].toLowerCase().replace(/^(?:www|ssh)\./, "");
  const parts = path.split("/");
  return parts.length >= 2 && !parts.includes("") ? { host, path: path.toLowerCase() } : null;
}

// Whether a remote's URL is the repository a PR's URL belongs to: the same
// host, and the PR's owner/repo (its first two path parts) is the remote's.
export function sameRepo(prUrl, remoteUrl) {
  const pr = parseRepoUrl(prUrl);
  const remote = parseRepoUrl(remoteUrl);
  if (!pr || !remote) return false;
  return pr.host === remote.host && pr.path.split("/").slice(0, 2).join("/") === remote.path;
}

// The remotes whose URL is the PR's base repository, `origin` and `upstream`
// first. `git` runs in the repo; `ls-remote --get-url` is local (it applies
// `url.<base>.insteadOf`).
export async function remotesFor(git, prUrl) {
  const names = (await git(["remote"])).stdout.split("\n").map((n) => n.trim()).filter((n) => n && !n.startsWith("-"));
  const rank = (n) => (n === "origin" ? 0 : n === "upstream" ? 1 : 2);
  const found = [];
  for (const name of names.sort((a, b) => rank(a) - rank(b) || (a < b ? -1 : 1))) {
    const r = await git(["ls-remote", "--get-url", name]);
    if (r.code === 0 && sameRepo(prUrl, r.stdout.trim())) found.push(name);
  }
  return found;
}

// The ref to compare against for a PR's base branch: `<remote>/<base>` for
// the first remote that is the PR's base repository and has that ref here,
// else null (the local branch of that name is not used: it can be stale).
export async function prRef(git, base, prUrl) {
  for (const remote of await remotesFor(git, prUrl)) {
    const r = await git(["rev-parse", "--verify", "--quiet", `refs/remotes/${remote}/${base}^{commit}`]);
    if (r.code === 0 && SHA.test(r.stdout.trim())) return `${remote}/${base}`;
  }
  return null;
}

// The PR of the repo's branch as the mod uses it: {number, base, ref,
// headOid, url} with `ref` the ref to compare against, or null. A failure to
// run `gh` or git (not installed, not logged in, a remote that can't be
// reached) is "no PR", as is a PR whose base repository is no remote here or
// whose base is no ref here.
export async function lookupPr(gh, git) {
  let r;
  try {
    r = await gh(PR_ARGS);
    if (r.code !== 0 && /unknown json field/i.test(`${r.stderr ?? ""}${r.stdout ?? ""}`)) r = await gh(PR_ARGS_OLD);
  } catch {
    return null;
  }
  const pr = r.code === 0 ? parsePr(r.stdout) : null;
  if (!pr?.url) return null;
  let ref = null;
  try {
    ref = await prRef(git, pr.base, pr.url);
  } catch {
    // no ref: no PR base
  }
  return ref ? { ...pr, ref } : null;
}

// Where `gh` is: the app's PATH may lack /opt/homebrew/bin. The first of the
// candidates that runs (`run(cmd, args) -> {code}`, rejecting when it is not
// there) is used. The answer, also "none" (null), is found once and kept.
export const GH_CANDIDATES = ["gh", "/opt/homebrew/bin/gh", "/usr/local/bin/gh"];
export function ghFinder(run, candidates = GH_CANDIDATES) {
  let found = null;
  return () => {
    found ??= (async () => {
      for (const cmd of candidates) {
        try {
          if ((await run(cmd, ["--version"])).code === 0) return cmd;
        } catch {
          // not there: the next
        }
      }
      return null;
    })();
    return found;
  };
}

// What was learned per repo: {pr, head, branch, at, broken}. `pr` null: asked,
// there is none. A PR answers only for the branch it was asked for (on no
// branch, only for that HEAD): `get` takes the branch and HEAD the list shows,
// so another branch's answer is never used. The entry of an earlier HEAD of
// the same branch still answers while the new one is asked for (so the base
// doesn't flicker back to the default for a commit).
export class PrCache {
  constructor(ttl = PR_TTL_MS) {
    this.ttl = ttl;
    this.entries = new Map();
  }

  // The PR to use for the repo's `branch` at `head`, or null. `broken`: a ref
  // the list found it could not compare against (the PR's base ref went) is
  // left alone.
  get(key, head, branch) {
    const e = this.entries.get(key);
    const fits = e && e.branch === (branch ?? null) && (e.branch !== null || e.head === (head ?? null));
    return fits && e.pr && e.pr.ref !== e.broken ? e.pr : null;
  }

  // The PR known for the repo, whatever the branch: for the status that
  // *tells* the branch (not known before it). The caller checks the status's
  // branch with `get` and drops that status when the PR does not fit.
  tentative(key) {
    const e = this.entries.get(key);
    return e?.pr && e.pr.ref !== e.broken ? e.pr : null;
  }

  // Whether to ask `gh` now: nothing known, or HEAD or the branch moved, or
  // the answer is old.
  due(key, head, branch, now = Date.now()) {
    const e = this.entries.get(key);
    return !e || e.head !== head || e.branch !== branch || now - e.at >= this.ttl;
  }

  // The answer for this HEAD and branch.
  set(key, { pr, head, branch, at = Date.now() }) {
    const was = this.entries.get(key);
    this.entries.set(key, { pr, head, branch, at, broken: was?.branch === branch ? was.broken : null });
  }

  // Drops the entry (its PR was found not to be this branch's).
  drop(key) {
    this.entries.delete(key);
  }

  // Whether the list shown (a status of the Committed view, with `pr_base`:
  // the PR ref it was built against, or none) must load again: the PR this
  // cache holds for its branch and HEAD gives another base than it used.
  changes(key, status) {
    return (this.get(key, status.head, status.branch)?.ref ?? null) !== (status.pr_base ?? null);
  }

  // The list could not compare against the PR's ref (it is gone).
  markBroken(key, ref) {
    const e = this.entries.get(key);
    if (e) e.broken = ref;
  }
}

// What the header says: null (no PR in use), else {number, unpushed}: the
// PR's number, and whether HEAD is not the PR's head (commits not pushed, or
// the PR behind). `headOid` unknown: no claim.
export function prMark(pr, head) {
  if (!pr) return null;
  return { number: pr.number, unpushed: Boolean(pr.headOid && head && pr.headOid !== head) };
}
