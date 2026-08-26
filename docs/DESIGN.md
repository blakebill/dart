# Dart renderer design contract

This document defines the reusable visual and interaction rules for the main
renderer. New pages should compose these primitives instead of adding another
page-specific panel system.

## Tokens

Base spacing, radii, control sizes and typography live in `style.css`.

- Spacing uses `--space-1` through `--space-6`.
- Inputs and selects use `--control-height` and `--field-width`.
- Compact command actions use `--control-height-compact`.
- Cards use `--radius-card`; page panels use `--radius-panel`.
- Typography uses the shared 9/10/11/12/13/15/17/20px `--font-*` scale.
  Page, section, body, UI, caption and metric text must use the matching
  token rather than introducing page-local font sizes.
- Theme colors must use semantic variables such as `--surface`, `--border`,
  `--text-dim` and `--accent`; components must not introduce fixed light-only
  colors.

One-off dimensions are acceptable for data visualizations and virtualized row
geometry, but should include a comment explaining the constraint.

## Components

### Page header

Each tab has one `h1`. The top bar mirrors the active navigation label without
decorative emoji. A page begins with either a command bar or a grouped canvas
section.

### Panel and card

- Use `.workspace-section` for grouped configuration content.
- Use `.panel` for dashboard modules.
- Use `.live-data-surface` for nodes, connections and logs.
- Do not wrap one of these surfaces in another decorative panel.
- Mica belongs to the window background. Content surfaces use the stable
  `--surface` or `--field` fills and must not add another backdrop blur.

### Menus

Dropdown, context and overflow menus share `--menu-surface`, `--menu-border`
and `--menu-shadow`. They must remain 92–96% opaque, support keyboard
navigation and close on Escape or an outside pointer action.

### Command bar

Use `.workspace-commandbar` as the first child of a live data surface. Status
copy grows; filters follow; counts use `.commandbar-count`; the primary action
is last.

### Form field

Labels must remain visible unless the surrounding component provides an
equivalent accessible name. Text inputs and selects in label-control rows use
`--field-width`. Large editors and URL entry rows may use
`--field-width-wide` or flexible width.

### Empty state

Use `App.ui.renderEmptyState()`. Empty states contain:

1. One Fluent/MDL2 icon.
2. A short explanation.
3. One recovery action when the user can resolve the state elsewhere.

### Actions

A section should expose at most one primary action. Destructive actions use
the danger styles and must not visually compete with the normal primary path.
Profile cards keep Enable and Update visible; editing and destructive actions
belong in the accessible overflow menu.

## Responsive behavior

- The primary desktop design baseline is 1280x800.
- At that baseline, the workspace uses the 0.9.7 rhythm: a 24px content inset,
  20px panel padding and an expanded 208px sidebar.
- Compact windows remain usable down to the supported 880x600 minimum without
  horizontal overflow.
- Tool cards use three columns on desktop, two below 1100px and one below
  720px.
- Settings controls stay equal-width; the unified save bar remains reachable
  and may stack on narrow layouts. The save bar is hidden until a draft changes.
- Dashboard runtime events remain bounded to six compact entries and network
  quality uses the shared typography scale.
- Data lists own their scrolling. The window should not scroll while nodes,
  connections or logs update.

## Visual regression

Run `npm run test:visual` to compare deterministic Electron captures with
`test/visual-baselines`. Run `npm run test:visual:update` only after reviewing
an intentional design change.

Visual fixtures disable motion, use fixed state and never access user
subscriptions or runtime data. Retina captures are normalized to logical
pixels. The visual suite also asserts overflow, dashboard height, settings
control widths, dirty save-bar state, profile overflow actions and tool grids.
