# 05 — Client

`packages/client`. Vite + React 18 + TypeScript + react-three-fiber + drei + zustand + vite-plugin-pwa. `prototype/index.html` is the visual reference; match its look, rigs and animations unless this document says otherwise. Fonts: Cinzel (display), IBM Plex Sans (body), IBM Plex Mono (data), via Google Fonts with fallbacks.

## State

One zustand store mirrors the server snapshot: `projects`, `teams`, `units`, `alerts`, `unitTypes`, `transcripts[unitId]` (ring buffer, 500), `messages`, `connection` (`connecting | live | offline`), `selection` (Set of unit ids), `mode` (`idle | move | multi`), `sheet` (mobile sheet mode). Applied from WS deltas; all mutations go through REST calls in `api/` with optimistic updates only for selection and local UI state. On WS reconnect, replace the store with the new snapshot.

## Layout

Detect mobile with `(pointer: coarse) and (max-width: 1024px)` or width < 720 px. Both layouts share the canvas and the store; only chrome differs.

**Desktop**
- Header: brand, counters (units, working, awaiting input, teams), connection pill, Legend.
- Left command bar: Next orders (count), Recruit (R), Broadcast (B), Move/reassign (M), Compact idle, Halt all, Sound alerts, Messages.
- Right: alert stack (Civ-style tiles, newest on top, click to jump). Shifts left when the side panel is open.
- Right side panel (340 px): unit / group / project / team / legend views.
- Bottom tray: horizontally scrolling roster of teams then units.
- Keyboard: N / Space next-orders, R recruit, B broadcast, M move, Esc clear/close, Shift-click multi-select.

**Mobile**
- Compact header.
- Bottom tab bar: Units, Alerts (badge), Commands, Next (count). A full-width transient banner under the header for new alerts (5 s, tap to jump).
- Bottom sheet (52 % height, 78 % for list modes) replaces the side panel; drag handle; `+ multi` toggle in its header replaces Shift-click.
- Inputs ≥ 16 px font (prevents iOS/Android zoom). Camera nudges the selected unit above the sheet.
- Touch: one finger pans, pinch zooms, two-finger drag rotates (as in the prototype).

## Map

- Pointy-top hex tiles (`CylinderGeometry(0.96, 0.99, 0.35, 6)`), project territories tinted with `project.tint`, gold territory borders drawn as line segments on outer edges, dark "sea" plane beneath, fog. Hover highlight on tiles.
- Camera: orbit with target/distance/yaw/pitch state; defaults as prototype; clamp distance 8–40, pitch 0.35–1.45.
- Lights: hemisphere + warm directional with shadows (1024 map on coarse pointers, 2048 otherwise) + cool rim.
- Labels: DOM overlays positioned by projecting world points each frame (unit name with status dot, `+N` queued, `Nm` idle minutes, mission-complete flag; project names in Cinzel small caps). Fade unit labels when zoomed far out.
- Performance budget: 60 fps desktop, ≥ 30 fps mid-range Android with 24 units. Rigs are instanced where possible; animation runs in `useFrame` without allocations; `prefers-reduced-motion` disables bob/idle motion but keeps status colour changes.

## Units (rigs)

Low-poly soldiers built from boxes/cylinders with `flatShading`, parts grouped for posing: `legs`, `torso`, `armL`, `armR`, `head`, `props`. Port `buildSoldier()` from the prototype as a React component `<Soldier type projectFlag status …/>` and `poseSoldier()` as the per-frame animator. Rig variants and props by type (from `unit-types.json`):

| Type | Headgear | Props | `workAnim` |
|---|---|---|---|
| engineer | yellow hard hat | clipboard (L), calculator (R), survey tripod beside | `survey`: cycle scope → calculator keys → reading plans |
| infantry | helmet | pickaxe (R) | `dig`: overhead swing with torso follow-through |
| sniper | ghillie hood | rifle with scope glint | `sweep`: shouldered rifle, slow yaw sweep, glint at each end |
| captain | peaked cap, type band | folder with flipping page | `paperwork`: head down, page flips |
| major | peaked cap, 1 star | radio with antenna ping | `radio`: handset to ear, paces 2 steps each way |
| general | peaked cap, 3 stars | baton, bark rings | `bark`: baton jabs, head turns, expanding rings from the mouth |

Shared status poses: `waiting` = right hand raised, head up, looking around; `error` = shudder + head shake; `idle` = at ease, breathing, occasional look-around; `done` = salute (new; 1 s, then at ease) and a small flag on the base; `offline` = rig desaturated, no plate glow.

Identity on every rig: project `flag` colour on the left armband and the hexagonal base plate (emissive, pulses while working); type colour on the cap band, chest patch and epaulettes; stars on the cap by rank. Ground rings: green rotating work ring (working), team ring (team colour, hexagonal), gold selection ring. A beacon above the head for `waiting` (blue) and `error` (red).

## Panels

**Unit** (single selection): header with type glyph, name, `rank · model · project`; status chip; mission line (editable); activity line; `sessionId` with copy; tabs:
- *Transcript*: virtualised list of `TranscriptEntry`s, tool calls collapsed to one line with ok/fail, results highlighted; auto-scroll unless the user scrolled up; "Load earlier" fetches `/transcript?before`.
- *Orders*: input + Send / Interrupt & send / Queue (when working); queued orders list with remove; quick buttons: Approve / Deny (when waiting on permission, with the tool summary and an "always allow this" checkbox), Answer (AskUserQuestion renders the question's options), Interrupt (Esc), /compact, Ack, Start/Stop.
- *Messages*: thread list; compose to any allowed recipient with priority; Relay output.
- *Settings*: model select (live), permission mode select (live), team membership, move.

**Group** (multi-select or territory click): member list with status; broadcast box with "queue if busy"; Group into team / Disband; Halt selected.

**Project**: name, cwd, counts, free hexes, recruit here.

**Legend**: unit types with model, role, colours; status colours; identity key.

**Recruit** dialog: name, type, project, first order, model override, permission mode; places on the first free hex of the project.

## Alerts and sound

Alert tile: left stripe by kind (blue waiting, red error, gold done, amber idle, green message/info), type glyph, title, body, age. Click → select unit + focus camera + dismiss. Optional WebAudio beeps (triangle wave, 660 Hz waiting, 220 Hz error, 880 Hz done) gated behind a user toggle because browsers require a gesture.

## PWA

- `vite-plugin-pwa` with `registerType: "autoUpdate"`, manifest: name "Hex Command", `display: standalone`, `orientation: any`, theme `#0b0f14`, icons 192/512 (a gold hexagon with a star, generated SVG → PNG at build).
- Service worker precaches the app shell; API and WS are network-only. Offline: the app opens, shows the last snapshot from IndexedDB (idb-keyval) with a red "offline" pill, and all commands are disabled.
- Web Push: client asks for permission from a settings toggle, subscribes with the server's VAPID key, posts the subscription. Notifications deep-link to `/#unit-<id>`; the app selects that unit on load. Push only arrives while Chrome is alive on Android; document this limitation in the settings UI.
- HTTPS is required for installability and push: README documents `tailscale serve` (recommended) and `mkcert` for LAN.

## Accessibility and quality

- Every control is keyboard reachable with visible focus; panels are `aria-live="polite"` for status chips; alerts region is `aria-live`.
- Colour is never the only status signal (dot + text chip everywhere).
- Lighthouse PWA audit passes installability; no console errors; strict TypeScript; vitest for store reducers and the status→pose mapping; one Playwright smoke test that loads the app against a mocked WS snapshot and asserts 14 unit labels render.
