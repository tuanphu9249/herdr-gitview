// The Branch view's base: what the picker lists (branches, remote branches,
// tags, recent commits), and how a picked ref becomes the three values the
// engine takes (`--base <label> --merge-base <sha> --head <HEAD sha>`; see
// the engine's `status`: it uses them only when all three are given and
// `--head` is the repo's HEAD now, else it silently finds its own base, and
// `diff` shows a file as all added for a merge-base it can't resolve). So the
// mod resolves the ref itself, here, before every status.
//
// Pure: git is a function `git(args) -> {code, stdout}` (the caller runs it
// in the repo, on its machine), so the tests can run it on a real folder.

export const KIND_ORDER = ["branch", "remote", "tag", "commit"];
const CAPS = { branch: 200, remote: 200, tag: 100 };
const SHA = /^[0-9a-f]{40,64}$/;

// `git for-each-ref` format and `git log` format, tab separated.
export const REFS_ARGS = ["for-each-ref", "--sort=-creatordate", "--format=%(refname)%09%(objectname:short)%09%(subject)", "refs/heads", "refs/remotes", "refs/tags"];
export const LOG_ARGS = ["log", "-20", "--format=%H%x09%h%x09%s"];

const PREFIX = [["refs/heads/", "branch"], ["refs/remotes/", "remote"], ["refs/tags/", "tag"]];

// The refs, newest first within a kind: [{kind, ref, label, detail}]. `ref`
// is the full name (no tag and branch of one name mixed up), `label` the
// short one, `detail` the sha and the subject. A remote's HEAD is no branch.
export function parseRefs(text) {
  const out = [];
  const count = { branch: 0, remote: 0, tag: 0 };
  for (const line of String(text ?? "").split("\n")) {
    const [ref, sha, ...subject] = line.split("\t");
    const hit = PREFIX.find(([p]) => ref?.startsWith(p));
    if (!hit || ref.endsWith("/HEAD")) continue;
    const [prefix, kind] = hit;
    if (count[kind]++ >= CAPS[kind]) continue;
    out.push({ kind, ref, label: ref.slice(prefix.length), detail: [sha, subject.join("\t")].filter(Boolean).join(" ") });
  }
  return out.sort((a, b) => KIND_ORDER.indexOf(a.kind) - KIND_ORDER.indexOf(b.kind));
}

// The commits: [{kind: "commit", ref: <full sha>, label: <short sha>, detail: <subject>}].
export function parseLog(text) {
  const out = [];
  for (const line of String(text ?? "").split("\n")) {
    const [sha, short, ...subject] = line.split("\t");
    if (SHA.test(sha ?? "")) out.push({ kind: "commit", ref: sha, label: short, detail: subject.join("\t") || "(no message)" });
  }
  return out;
}

// The picker's rows: the engine's default first (`defaultLabel` may be
// unknown yet; the row that clears the pick), then branches, remote branches,
// tags, the commits.
export function baseOptions({ defaultLabel = null, refs = [], commits = [] }) {
  const first = { kind: "default", ref: null, label: defaultLabel ?? "default", detail: defaultLabel ? "default" : "the engine's choice" };
  return [first, ...refs, ...commits];
}

// What a search keeps: every word is somewhere in the kind, label or detail.
export function filterOptions(options, query) {
  const words = String(query ?? "").toLowerCase().split(/\s+/).filter(Boolean);
  if (!words.length) return options;
  return options.filter((o) => {
    const hay = `${o.kind} ${o.label} ${o.detail}`.toLowerCase();
    return words.every((w) => hay.includes(w));
  });
}

// Whether the picker row is the stored pick (`pick` null: the default row).
export const isCurrent = (option, pick) => (pick ? option.ref === pick.ref : option.kind === "default");

// The stored pick for a row: {ref, label}; null for the default (clears it).
export const pickOf = (option) => (option.kind === "default" ? null : { ref: option.ref, label: option.label });

// The lists, from git in the repo: one call for the refs, one for the log.
export async function loadLists(git) {
  const [refs, log] = await Promise.all([git(REFS_ARGS), git(LOG_ARGS)]);
  if (refs.code !== 0) throw new Error((refs.stderr || "git for-each-ref failed").trim());
  // An empty repo has no commits: no log, and that's fine.
  return { refs: parseRefs(refs.stdout), commits: log.code === 0 ? parseLog(log.stdout) : [] };
}

// A ref → what the engine needs: {ok: true, head, tip, mb}; `head`: HEAD's
// sha now, `tip`: the ref's commit, `mb`: `git merge-base HEAD <ref>`. Else
// {ok: false, why}: the ref is gone or shares no history with HEAD.
// `cache`: the last result for this ref; the merge-base is not asked again
// while HEAD and the ref's tip are as they were (one call a refresh), and
// when either moved it is computed again: that is how a HEAD change (a
// commit, a checkout, a pull) gives a new merge-base.
// A failure to run git at all rejects (a remote that can't be reached): the
// caller treats that as "try again", not as "the ref is gone".
export async function resolveBase(git, ref, cache = null) {
  if (!ref || ref.startsWith("-")) return { ok: false, why: `${ref ?? "no ref"} is not a ref` };
  const r = await git(["rev-parse", "HEAD", `${ref}^{commit}`]);
  const [head, tip] = r.stdout.trim().split("\n");
  if (r.code !== 0 || !SHA.test(head ?? "") || !SHA.test(tip ?? "")) return { ok: false, why: `${ref} is not a commit here` };
  if (cache?.ok && cache.head === head && cache.tip === tip) return { ...cache };
  const m = await git(["merge-base", head, tip]);
  const mb = m.stdout.trim();
  if (m.code !== 0 || !SHA.test(mb)) return { ok: false, why: `HEAD and ${ref} have no common history` };
  return { ok: true, head, tip, mb };
}

// `status`'s arguments for a pick resolved by resolveBase.
export const baseArgs = (label, r) => ["--base", label, "--merge-base", r.mb, "--head", r.head];

// Whether a status really carries the base asked for: HEAD moving between
// our look and the engine's makes it find its own base without an error.
export const carries = (status, r) => status?.base?.merge_base === r.mb && status?.head === r.head;
