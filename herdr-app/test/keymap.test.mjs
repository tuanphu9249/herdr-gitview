// The keys the footer and the card offer (keymap.js), from the list's
// tables (modes.js).
import "./stub.mjs";
import { test } from "node:test";
import assert from "node:assert/strict";
const { chipsOf, cardOf } = await import("../mods/gitview/keymap.js");
const { MODES } = await import("../mods/gitview/modes.js");

const caps = (entries) => entries.flatMap((e) => e.caps);
const { viewById } = await import("../mods/gitview/views.js");
// The list's `v`: the view it shows is an entry of views.js.
const view = (id) => ({ viewDef: () => viewById(id), handedOff: () => false, list: () => null });

// Round 10 (U5): in "vs base" the row refuses s/u/x and there's no commit
// box, yet the footer and the card offered them.
test("vs base, the footer and the card don't offer s, u, x or c", () => {
  const v = view("branch");
  for (const k of ["s", "u", "x", "c"]) {
    assert.equal(caps(chipsOf([MODES.files.keys], v)).includes(k), false, k);
    assert.equal(caps(cardOf([{ title: "", table: MODES.files.keys }], v)[0].keys).includes(k), false, k);
  }
});

test("the Committed view is read only too: no s, u, x or c", () => {
  const v = view("committed");
  for (const k of ["s", "u", "x", "c"]) assert.equal(caps(chipsOf([MODES.files.keys], v)).includes(k), false, k);
});

test("in the working tree they're there, most useful first", () => {
  const chips = caps(chipsOf([MODES.files.keys], view("uncommitted")));
  assert.deepEqual(chips.slice(0, 2), ["s", "u"]);
  assert.ok(["x", "c"].every((k) => chips.includes(k)));
});

test("the base key (b) is offered in the views against a base only; w names the three views", () => {
  assert.equal(caps(cardOf([{ title: "", table: MODES.files.keys }], view("branch"))[0].keys).includes("b"), true);
  assert.equal(caps(cardOf([{ title: "", table: MODES.files.keys }], view("committed"))[0].keys).includes("b"), true);
  assert.equal(caps(cardOf([{ title: "", table: MODES.files.keys }], view("uncommitted"))[0].keys).includes("b"), false);
  const w = cardOf([{ title: "", table: MODES.files.keys }], view("branch"))[0].keys.find((k) => k.caps.includes("w"));
  assert.equal(w.label, "uncommitted / branch / committed");
});
