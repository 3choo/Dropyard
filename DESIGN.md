---
name: dropyard
description: Private release hub for a FiveM server team — a dark developer instrument console for multi-GB uploads.
colors:
  ground: "#0C0E11"
  panel: "#12151A"
  panel-raised: "#171B21"
  overlay: "#1C2128"
  hairline: "#232830"
  hairline-strong: "#2E3540"
  ink: "#E8EBEF"
  ink-secondary: "#A6B0BC"
  ink-tertiary: "#7E8896"
  accent: "#C9F24F"
  accent-hover: "#DCFF66"
  accent-dim: "#A8C93F"
  accent-ink: "#131608"
  danger: "#FF6B5E"
  danger-wash: "#3A1F1D"
  warn: "#FFC24B"
  warn-wash: "#3A3018"
  info: "#6BB0FF"
typography:
  display:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "22px"
    fontWeight: 600
    letterSpacing: "-0.02em"
    lineHeight: 1.2
  title:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "15px"
    fontWeight: 600
    lineHeight: 1.3
  body:
    fontFamily: "Geist Variable, ui-sans-serif, system-ui, sans-serif"
    fontSize: "13px"
    fontWeight: 400
    lineHeight: 1.5
  label:
    fontFamily: "JetBrains Mono Variable, ui-monospace, monospace"
    fontSize: "11.5px"
    fontWeight: 400
    lineHeight: 1.4
rounded:
  control: "8px"
  card: "12px"
  overlay: "16px"
  cell: "2px"
spacing:
  xs: "4px"
  sm: "8px"
  md: "16px"
  lg: "24px"
  xl: "40px"
components:
  button-primary:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent-ink}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 12px"
  button-secondary:
    backgroundColor: "{colors.panel-raised}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "32px"
    padding: "0 12px"
  chip-accent:
    backgroundColor: "{colors.accent}"
    textColor: "{colors.accent}"
    rounded: "6px"
    height: "20px"
  input:
    backgroundColor: "{colors.panel}"
    textColor: "{colors.ink}"
    rounded: "{rounded.control}"
    height: "32px"
---

# Design System: dropyard

## Overview

**Creative North Star: "The Instrument Console"**

dropyard treats a six-gigabyte upload as routine. The interface is a dark developer console where the transfer itself is visible: every measured value — bytes, versions, digests, throughput — sits in tabular mono type like a readout, and the accent color behaves like an instrument's active trace, marking only what is live, current, or actionable. Nothing glows, nothing decorates; depth comes from layered charcoal surfaces and one glass surface reserved for command.

The density is deliberately compact: 13px body text, tight rows, hairline separators, a left rail that anchors navigation and a storage meter. The user pinned this world ("dark developer"), and the build commits to it — chartreuse at real weight on primary actions, selection, and progress, never scattered as ornament.

**Key Characteristics:**
- Charcoal ground with hairline-separated surfaces; one committed hue (chartreuse) doing real jobs
- Geist for UI voice, JetBrains Mono with tabular figures for every measured value
- Rows, not cards — dense console lists with right-aligned mono metrics
- One authored motion moment per surface (the upload chunk mosaic); exponential ease-out everywhere
- A single glass surface (the command palette); everything else is matte

## Colors

One accent carries the whole identity; neutrals are cool charcoals tinted from the same blue-green cast as the ground.

### Primary
- **Signal Chartreuse** (#C9F24F): the only committed hue. Primary buttons, active nav markers, version chips for the latest release, progress fills, the mosaic's completed cells, focus rings, selection. Never body text on dark ground — it earns attention by rarity.
- **Chartreuse Hover** (#DCFF66) / **Chartreuse Dim** (#A8C93F): hover and pressed states of the primary.

### Tertiary (state semantics only)
- **Fault Red** (#FF6B5E on wash #3A1F1D): failed parts, destructive actions, errors.
- **Draft Amber** (#FFC24B on wash #3A3018): draft-state chips and warnings — an unpublished release is the only thing that is amber.
- **Info Blue** (#6BB0FF): reserved; not currently used for decoration anywhere.

### Neutral
- **Console Ground** (#0C0E11): page background.
- **Panel** (#12151A) / **Panel Raised** (#171B21): surfaces and rows.
- **Overlay** (#1C2128): the command palette and floating chrome.
- **Hairline** (#232830) / **Hairline Strong** (#2E3540): 1px borders and separators; strong for hover and scrollbar thumb.
- **Ink** (#E8EBEF) / **Ink Secondary** (#A6B0BC) / **Ink Tertiary** (#7E8896): text hierarchy; tertiary is the floor and must stay ≥4.5:1 on ground.

### Named Rules
**The One Hue Rule.** Chartreuse is the only saturated color on any screen and covers ≤10% of it. If a second hue appears, it must be a state color carrying meaning (danger/draft), never decoration.

**The Mono Meter Rule.** Any value a teammate could measure — size, version, digest, count, throughput, timestamp — is set in JetBrains Mono with tabular figures. Geist never renders a measurement.

## Typography

**Display Font:** Geist Variable (self-hosted, fallback ui-sans-serif/system-ui)
**Body Font:** Geist Variable
**Label/Mono Font:** JetBrains Mono Variable (self-hosted, fallback ui-monospace)

**Character:** A workhorse grotesk with dev-tool lineage paired with an unapologetic mono — the pairing reads as an instrument panel, not a document.

### Hierarchy
- **Display** (600, 22px, 1.2, −0.02em tracking): one per page — "Projects", project name, "New release".
- **Title** (600, 15px): section headings inside a page ("Releases", "Files", admin tabs).
- **Body** (400, 13px, 1.5): all UI copy and descriptions; measure stays well under 75ch by layout.
- **Label/Mono** (400, 11–12.5px, tabular): metrics, versions, paths, digests, timestamps, slugs.

## Layout

A fixed 224px left rail (wordmark, nav, storage meter, user chip) beside a single main column capped at 896px, centered, padded 32px (20px below `md`). Below 768px the rail is replaced by a 48px top bar with inline nav. Lists are hairline-separated rows — project rows, release timeline entries, member rows — with right-aligned mono metrics; never equal-size card grids. The release timeline draws a 1px vertical spine with node dots. Spacing rhythm: more space above a heading than below it; stats strips sit between two hairlines like an instrument readout block.

## Elevation & Depth

Matte tonal layering: ground → panel → raised panel, separated by 1px hairlines, is the default depth system. Soft shadows appear only on floating chrome.

### Shadow Vocabulary
- **Overlay** (`0 16px 48px -12px rgb(0 0 0 / .55), 0 4px 16px -4px rgb(0 0 0 / .4)`): modals and the command palette.
- **Raised** (`0 8px 24px -8px rgb(0 0 0 / .45)`): primary buttons only.

### Named Rules
**The One Glass Rule.** `backdrop-blur` exists on exactly one surface — the command palette (Overlay at 85% opacity). Everywhere else depth is matte layering. No glow, no zero-offset halos.

## Shapes

Controls round at 8px, cards and panels at 12px, floating overlays at 16px, mosaic cells at 2px. Pills are reserved for chips (20px tall). Borders are 1px hairlines; elevation is declared once per element (border OR shadow, never both).

## Components

### Buttons
- **Shape:** softly rounded (8px), 32px tall, 13px text.
- **Primary:** chartreuse ground, near-black ink (#131608), medium weight; soft Raised shadow; darkens to hover (#DCFF66).
- **Secondary:** raised panel ground, hairline border, ink text; border lifts on hover.
- **Ghost / Danger:** transparent with tertiary ink; danger variant carries red text on red wash.
- **Focus:** 2px chartreuse outline offset 2px (global focus-visible).

### Chips
- **Style:** 20px tall, 6px radius, 11px mono text on tinted ground — `latest` in chartreuse/10 with chartreuse text; `draft` in amber/10 with amber text; neutral in raised panel.

### Cards / Containers
- **Corner:** 12px; background panel over ground; 1px hairline border, no shadow at rest; internal padding 16–20px.

### Inputs
- **Style:** panel ground, hairline border, 8px radius, 32px tall; placeholder in tertiary ink.
- **Focus:** border shifts to chartreuse at 60% — no glow.

### Navigation
- Left rail: 224px, items 32px tall, square 6px chartreuse marker beside the active item, raised-panel pill on hover/active. Mobile: top bar with the same links inline.

### Chunk Mosaic (signature)
Each uploading file renders as a grid of 9px cells (2px radius, 3px gap) — one per multipart part, bucketed to ≤240 cells. Pending cells are hairline-strong; in-flight cells chartreuse at 55%; landed cells full chartreuse; failed cells red. On completion the mosaic collapses (scaleY to 0.2, fade) into a single chartreuse progress line — the upload's authored moment. Entrances stagger ≤30ms apart on exponential ease-out `cubic-bezier(0.16, 1, 0.3, 1)`; all motion respects `prefers-reduced-motion`.

## Do's and Don'ts

### Do:
- **Do** set every measured value in mono tabular figures.
- **Do** keep chartreuse for what is live, current, or actionable — active nav, latest release, primary action, progress.
- **Do** use hairline rows with right-aligned metrics for any list of things.
- **Do** theme browser surfaces: chartreuse selection tint, themed caret, dark scrollbars with hairline-strong thumbs.

### Don't:
- **Don't** add a second decorative hue, gradient text, or glow — state colors only, with meaning.
- **Don't** put `backdrop-blur` anywhere but the command palette.
- **Don't** use kicker/eyebrow labels above headings, card grids for lists, or icons as emoji/glyphs — icons are the drawn 1.75px-stroke set.
- **Don't** animate with linear or ease-in curves; the console moves on exponential ease-out, sparsely.
