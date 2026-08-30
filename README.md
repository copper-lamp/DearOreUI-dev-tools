<div align="center">
  <h1>DearOreUI Designer</h1>
  <p><strong>Design and preview Minecraft Bedrock OreUI — without launching the game.</strong></p>
  <p>An offline visual designer (Tauri 2) for mods built on the <a href="https://github.com/copper-lamp/Dear-OreUI">DearOreUI</a> runtime.</p>

  <p>
    <a href="https://github.com/copper-lamp/DearOreUI-dev-tools/releases">Downloads</a>
    ·
    <a href="https://github.com/copper-lamp/Dear-OreUI">Core runtime</a>
    ·
    <a href="https://copper-lamp.github.io/dearoreui-docs/">Documentation</a>
    ·
    <a href="https://github.com/magicobs0z/dearoreui-ExampleMod">Example mod</a>
    ·
    <a href="README_ZH.md">简体中文</a>
  </p>

  <p>
    <a href="https://github.com/copper-lamp/DearOreUI-dev-tools/releases"><img src="https://img.shields.io/github/v/release/copper-lamp/DearOreUI-dev-tools?style=for-the-badge&amp;label=release" alt="latest release"></a>
    <a href="https://github.com/copper-lamp/DearOreUI-dev-tools/releases"><img src="https://img.shields.io/github/downloads/copper-lamp/DearOreUI-dev-tools/total?style=for-the-badge" alt="downloads"></a>
    <a href="https://github.com/copper-lamp/Dear-OreUI/blob/main/LICENSE"><img src="https://img.shields.io/badge/license-CC0--1.0-2f6f9f?style=for-the-badge" alt="CC0-1.0 license"></a>
  </p>
</div>

![runtime](public/runtime.png)

## What is it?

DearOreUI Designer lets mod authors **see their UI without running Minecraft**. Point it at a mod's source tree, and it statically scans the code to recover the OreUI pages the mod declares — no mod-side changes required — then renders them on an in-app canvas that approximates the OreUI (Coherent Gameface) layout engine.

| | |
| --- | --- |
| **Target users** | Authors of [DearOreUI](https://github.com/copper-lamp/Dear-OreUI) client mods |
| **Position** | Offline preview & debugging companion to the DearOreUI runtime |
| **Workflow** | Open mod directory → auto-detect pages → click to preview → refresh on save |

## Core capabilities

- **Mod UI auto-detection (source scan).** Reads `registerComponent` calls from C++ source, recovering `DomNode` bodies and `ComponentSpec` trees. **The mod needs no modification.**
- **Offline preview.** Render detected UI on a canvas without a game client; a Yoga-based layout pass mimics the OreUI box model.
- **Dual-loading model.** Preview both standalone mod entries and the "vanilla screen + mod overlay" combination.
- **Sidebar tabs.** Only pages the mod actually changes/declares are shown; untouched screens stay hidden.
- **Vanilla resource import (planned).** Import `data/gui/dist/hbui` assets for pixel-accurate 9-slice textures.

## Install

Download the latest installer from [Releases](https://github.com/copper-lamp/DearOreUI-dev-tools/releases), install, and launch.

## Usage

1. Launch the desktop app.
2. **Project → Open mod directory**, select a mod source tree (e.g. `dearoreui-ExampleMod`).
3. Auto-detected pages appear as sidebar tabs; click one to preview on the canvas.
4. **Project → Import vanilla resources** to load original UI assets for closer-to-device rendering (planned).

## Tech stack

| Layer | Technology |
| --- | --- |
| Desktop host | Tauri 2 |
| UI | Vite + TypeScript |
| Rendering | Yoga layout pass approximating OreUI (Coherent Gameface); reuses the runtime's `stage7` scripts and `{t,s,x,a,c}` node format |
| Scanner | `src-tauri/src/mod_scanner.rs` — static, read-only C++ source analysis |

## Development

```powershell
npm install        # install dependencies
npm run tauri dev  # start the desktop app in dev mode
```

The Rust scanner lives in `src-tauri/src/`; the rendering frontend in `src/`. Build releases with `npm run tauri build` (see `.github/workflows/release.yml`).

## Ecosystem

This is one part of the DearOreUI toolchain:

| Project | Repository | Role |
| --- | --- | --- |
| **DearOreUI** | [copper-lamp/Dear-OreUI](https://github.com/copper-lamp/Dear-OreUI) | Native LeviLamina runtime — extends OreUI at runtime |
| **DearOreUI Designer** | [copper-lamp/DearOreUI-dev-tools](https://github.com/copper-lamp/DearOreUI-dev-tools) | This repo — offline visual preview |
| **DearOreUI Docs** | [copper-lamp/dearoreui-docs](https://github.com/copper-lamp/dearoreui-docs) | Official documentation & learning site |
| **dearoreui-ExampleMod** | [magicobs0z/dearoreui-ExampleMod](https://github.com/magicobs0z/dearoreui-ExampleMod) | Progressive tutorial mod |
| **dearoreui-repo** | [copper-lamp/dearoreui-repo](https://github.com/copper-lamp/dearoreui-repo) | Self-hosted xmake package repo |

## License

[CC0-1.0](https://github.com/copper-lamp/Dear-OreUI/blob/main/LICENSE), matching the DearOreUI runtime.