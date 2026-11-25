// The header's two controls, each a Popover (gpui-base) opened by a click on
// its trigger: the view switch (one row per entry of views.js VIEWS) and,
// in a view that is against a base, the base picker (a search box over the
// list bases.js builds). Rows in, elements out; the list's `v` keeps the
// state (v.menu: null, "view" or "base") and does what a pick means.

import { div } from "gpui-kit";
import { h_flex, v_flex, Input, Popover } from "gpui-base";
import { icon, pill } from "./chrome.js";
import { VIEWS } from "./views.js";
import { filterOptions, isCurrent } from "./bases.js";

const MONO = "JetBrains Mono";
// The list shows this many rows at most (tags can be thousands); the search narrows it.
export const SHOWN_MAX = 200;

// What the base picker lists now: the search's matches, capped.
export const shownBases = (v) => filterOptions(v.baseOptions(), v.baseInput.value()).slice(0, SHOWN_MAX);

// A text button with a chevron: the Popover's trigger.
function trigger(t, id, text, { tip, max = null, open = false, accent = false }) {
  return h_flex()
    .id(id)
    .h(22)
    .flex_shrink(1)
    .min_w(0)
    .when(max !== null, (e) => e.max_w(max))
    .px(7)
    .gap(4)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .border_1()
    .border_color(open || accent ? t.accent : t.border)
    .text_size(12)
    .hover((s) => s.bg(t.raised))
    .tooltip(tip)
    .child(div().min_w(0).truncate().font_semibold().text_color(t.foreground).child(text))
    .child(icon("chevron-down", 11, t.dim));
}

// The menu's frame.
const panel = (t, width) => v_flex().w(width).rounded(8).border_1().border_color(t.border).bg(t.popover).shadow_lg().overflow_hidden();

function item(t, id, { on, onClick }) {
  return h_flex()
    .id(id)
    .h(28)
    .flex_none()
    .px(8)
    .gap(8)
    .items_center()
    .rounded(6)
    .cursor_pointer()
    .text_size(12)
    .when(on, (e) => e.bg(t.selected))
    .when(!on, (e) => e.hover((s) => s.bg(t.hover)))
    .on_click((_e, cx) => onClick(cx));
}

const check = (t, on) => div().w(12).flex_none().text_color(t.accent).child(on ? "✓" : "");

// The view switch: the current view's title; its menu lists every view.
function viewSwitch(v, t) {
  const open = v.menu === "view";
  const items = VIEWS.map((def) =>
    item(t, `gitview-view-${def.id}`, { on: def.id === v.viewId, onClick: (cx) => v.pickView(def.id, cx) })
      .child(check(t, def.id === v.viewId))
      .child(div().flex_1().text_color(t.foreground).child(def.title)),
  );
  return div().flex_none().child(Popover.new("gitview-view-menu")
    .open(open)
    .on_open_change((now, cx) => v.setMenu(now ? "view" : null, cx))
    .trigger(trigger(t, "gitview-view", v.viewDef().title, { tip: "View (w)", open }))
    .content(panel(t, 170).p(4).gap(1).children(items)));
}

function baseRow(t, o, i, v, pick) {
  const current = isCurrent(o, pick);
  return item(t, `gitview-base-${i}`, { on: i === v.baseAt, onClick: (cx) => v.pickBase(o, cx) })
    .child(check(t, current))
    .child(div().flex_none().max_w(150).truncate().text_color(t.foreground).when(o.kind === "commit", (e) => e.font_family(MONO)).child(o.label))
    .child(div().flex_1().min_w(0).truncate().text_size(11).text_color(t.dim).child(o.detail ?? ""))
    .child(pill(t, o.tag ?? o.kind, { accent: o.kind === "default" || o.kind === "pr" }));
}

// The base picker: the base's label; its menu is the search and the list.
function basePicker(v, t, pick) {
  const open = v.menu === "base";
  const rows = open ? shownBases(v) : [];
  const state = v.bases;
  const note = state.error ?? (state.loading && !state.refs ? "Loading…" : rows.length ? null : "No match");
  // (A Popover has no box of its own: the layout is its wrapper's.)
  return div().flex_shrink(1).min_w(0).child(Popover.new("gitview-base-menu")
    .open(open)
    .on_open_change((now, cx) => v.setMenu(now ? "base" : null, cx))
    .trigger(trigger(t, "gitview-base", v.baseLabel(), { tip: "Compare against… (b)", max: v.width < 340 ? 90 : 160, open, accent: Boolean(pick) }))
    .content(
      panel(t, Math.max(240, Math.min(360, v.width - 16)))
        .on_key_down((e, cx) => v.baseKey(e, cx))
        .child(
          div()
            .flex_none()
            .p(6)
            .border_b(1)
            .border_color(t.border)
            .child(Input.new(v.baseInput).h(28).px(8).flex().items_center().rounded(6).border_1().border_color(t.accent).text_size(12).text_color(t.foreground)),
        )
        .child(
          v_flex()
            .id("gitview-base-list")
            .max_h(280)
            .p(4)
            .gap(1)
            .overflow_y_scroll()
            .track_scroll(v.baseScroll)
            .children(rows.map((o, i) => baseRow(t, o, i, v, pick)))
            .when(Boolean(note), (e) => e.child(div().p(8).text_size(12).text_color(t.dim).child(note))),
        ),
    ));
}

// A small mark with a tooltip.
const mark = (t, id, text, tip, opts = {}) => div().id(id).flex_none().tooltip(tip).child(pill(t, text, opts));

// What takes the place of the header's "uncommitted" / "vs <base>" text. In
// the Committed view with a pull request: `#<number>` next to its base (when
// that is the base in use), and "unpushed" when HEAD is not the PR's head.
export function viewControls(v, t) {
  const pick = v.pick();
  const pr = v.viewDef().to ? v.prMark() : null;
  return h_flex()
    .flex_shrink(1)
    .min_w(0)
    .gap(4)
    .items_center()
    .child(viewSwitch(v, t))
    .when(v.viewDef().usesBase, (e) => e.child(basePicker(v, t, pick)))
    .when(Boolean(pr?.used), (e) => e.child(mark(t, "gitview-pr", `#${pr.number}`, `Pull request #${pr.number}: its base branch is the base`, { accent: true })))
    .when(Boolean(pr?.unpushed), (e) => e.child(mark(t, "gitview-unpushed", "unpushed", "HEAD differs from the pull request's head: the diff is against HEAD here")));
}
