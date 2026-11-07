<p align="center">
  <img src="showcase/tauri/src-tauri/icons/128x128@2x.png" width="128" alt="Roamies icon">
</p>

<p align="center">
  <img src="docs/art/hero.gif" alt="Roamies: JARVIS, a glowing globe of LED dots, ripples as it says &quot;At your service.&quot; beside a mouse cursor, while Roamie, Anime Girl, Sarah and Adrian wave and hop on either side">
</p>

<p align="center">
  <strong>A little buddy that lives on your screen and keeps you on track.</strong>
</p>

<p align="center">
  <a href="https://github.com/KenKaiii/Roamies/releases/latest"><img src="https://img.shields.io/github/v/release/KenKaiii/Roamies?style=for-the-badge&label=Download&color=78ffe2" alt="Roamies desktop release"></a>
  <a href="https://github.com/KenKaiii/Roamies/stargazers"><img src="https://img.shields.io/github/stars/KenKaiii/Roamies?style=for-the-badge&label=Stars&color=yellow" alt="Star Roamies on GitHub"></a>
  <a href="https://github.com/KenKaiii/Roamies/releases"><img src="https://img.shields.io/github/downloads/KenKaiii/Roamies/total?style=for-the-badge&label=App%20downloads&color=2ecc71" alt="Desktop app downloads"></a>
  <a href="LICENSE"><img src="https://img.shields.io/badge/License-AGPL--3.0-blue.svg?style=for-the-badge" alt="AGPL-3.0 License"></a>
  <a href="https://youtube.com/@kenkaidoesai"><img src="https://img.shields.io/badge/YouTube-FF0000?style=for-the-badge&logo=youtube&logoColor=white" alt="YouTube"></a>
  <a href="https://skool.com/kenkai"><img src="https://img.shields.io/badge/Skool-Community-78ffe2?style=for-the-badge" alt="Skool"></a>
</p>

Roamies is a little AI buddy that lives on your desktop. It stays by your cursor, talks back in its own
voice, keeps track of what you said you'd do and nudges you when it's due.

> ⭐ **If Roamies keeps you on track, give it a star.** It's the main way other people find it.

## Why Roamies

- **Talk, don't type.** Hold ⌃⌥ (Ctrl+Alt on Windows), say it, let go.
- **It talks back.** Spoken replies in its own voice, with real feeling, through [Fish Audio](https://fish.audio).
- **It remembers.** What you said you'd do, reminders down to the second, and what matters to you.
- **It sees and points.** Reads any window and points at exactly where to click.
- **It does the clicking.** Opens apps, sites and files, and clicks or types in other apps for you.
- **Your subscriptions.** Claude, ChatGPT, Gemini, Grok, Kimi or API keys.

| Pick your Roamie | What you get                                            |
| ---------------- | ------------------------------------------------------- |
| **JARVIS**       | **A glowing sphere of light that ripples as it speaks** |
| Roamie           | The original: a tiny glowing pixel creature             |
| Anime Girl       | A pixel anime girl                                      |
| Sarah            | A pixel woman                                           |
| Adrian           | A pixel man                                             |

<sub>Each one has its own name, voice and animations, in three sizes: Default, Small, or Cursor, a pixel pointer that rides along with your mouse.</sub>

## Also included

- **The Roamies panel:** click the menu bar icon on macOS for the panel, or the tray icon on Windows for Settings; both show what it's doing, what it remembers, and every setting.
- **Safe by default:** file edits, commands and app control stay off until you turn them on, and risky steps always ask.
- **Shows its work:** every tool plays its own animation, so you can see what it's doing.
- **Private keys:** your Fish Audio key stays in the macOS Keychain or encrypted on Windows, never in a file.
- **Out of the way:** no Dock icon, ⌃⌥S shows or hides it, Esc stops a reply.
- **Updates itself:** signed updates, installed in one click.
- **Quick setup:** permissions, sign-in and a short chat so it gets to know you.

|                         | macOS                      | Windows                     |
| ----------------------- | -------------------------- | --------------------------- |
| Talk to it              | Yes, best on macOS 26+     | Yes, speech runs on your PC |
| Dictation into any app  | Yes                        | Yes                         |
| Spoken replies          | Yes, with a Fish Audio key | Yes, with a Fish Audio key  |
| Memory and reminders    | Yes                        | Yes                         |
| Read windows and point  | Yes                        | Yes                         |
| Click and type in apps  | Yes                        | Yes                         |
| Ask about an area (⌃⌥A) | Yes                        | Not yet                     |

<sub>Spoken replies are billed to your own Fish Audio account; the panel (macOS) and Settings (Windows) show what each voice model costs. On
Windows, voice runs [Moonshine](https://github.com/moonshine-ai/moonshine) (MIT) speech on your PC by default
(about 140 MB, downloaded once from the setup guide), so your voice never leaves it. For the best accuracy, switch
to [NVIDIA Parakeet TDT 0.6B v3](https://huggingface.co/nvidia/parakeet-tdt-0.6b-v3)
([CC BY 4.0](https://creativecommons.org/licenses/by/4.0/)), in the ONNX export by
[istupakov](https://huggingface.co/istupakov/parakeet-tdt-0.6b-v3-onnx), run with
[parakeet-rs](https://github.com/altunenes/parakeet-rs) (about 670 MB, no live text), in the tray's Settings ›
Voice Engine. Models download on demand and aren't bundled. On Windows it never reads or types in apps running as
administrator or in password managers, and never types or clicks in terminals.</sub>

## Get started

1. Install Roamies:

   **macOS (Apple silicon or Intel):** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and open the `.dmg` for your Mac (`aarch64` for Apple silicon, `x64` for Intel).

   **Windows:** [Download the latest release](https://github.com/KenKaiii/Roamies/releases/latest) and run the `.exe` installer. It isn't code-signed yet, so Windows shows a SmartScreen warning the first time.

   **Development:** With Rust, Node.js 22+, the [Tauri prerequisites](https://v2.tauri.app/start/prerequisites/) and, on macOS, the Xcode Command Line Tools installed:

   ```bash
   git clone https://github.com/KenKaiii/Roamies.git
   cd Roamies/showcase/tauri
   (cd sidecar && npm ci && npm test)
   ./build.sh dev        # debug build
   ./build.sh            # release bundle for this OS
   ```

2. Open the app, follow the setup guide, pick your Roamie, and hold ⌃⌥ to say hi.

## Build with the framework

Every Roamie's brain is a [gg-framework](https://github.com/KenKaiii/gg-framework) agent running in a Node
sidecar. Want to build your own? Install just what you need.

- [**@kenkaiiii/gg-ai**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-ai/README.md): Connect to AI providers and stream responses.
- [**@kenkaiiii/gg-agent**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-agent/README.md): Build agents that use your tools and work through tasks.
- [**@kenkaiiii/gg-core**](https://github.com/KenKaiii/gg-framework/blob/main/packages/gg-core/README.md): Model selection, authentication, and local model discovery.

For your own agent, start here:

```bash
npm install @kenkaiiii/gg-ai @kenkaiiii/gg-agent
```

The package links above cover setup and usage. Roamies is licensed under [AGPL-3.0](LICENSE): you can build
on it, and if you distribute your changes or run them as a network service, you share their source under
the same license.

## What's in this repo

| Path | What |
|---|---|
| `showcase/tauri/src-tauri/` | The desktop app shell (Tauri 2, Rust) and the macOS voice and hands helpers (Swift) |
| `showcase/tauri/src-tauri/voice-rs/` | The default Windows voice helper (Rust, Moonshine speech on the PC) |
| `showcase/tauri/src-tauri/voice-win/` | The alternative Windows voice helper (Rust, Parakeet speech on the PC) |
| `showcase/tauri/src-tauri/voice-core/` | What both voice helpers share: the host protocol, the talk session and the chord state machine |
| `showcase/tauri/sidecar/` | Sidekick's brain: the gg-framework agent, its tools, memory and tests |
| `showcase/roamies/` | The creatures: physics, rendering, expressions, bubbles, tool animations, sounds |
| `showcase/onboarding/` | The setup guide |
| `showcase/panel/` | The Roamies panel on macOS: what it's doing, what it remembers, and every setting |
| `showcase/settings/` | The Settings window, which Windows opens from the tray: the same things, in sections |
| `docs/telemetry.md` | The local-only timing log: event schema, request ids, privacy and where the files live |

## Contributing

Bug reports, ideas and pull requests are welcome. [Open an issue](https://github.com/KenKaiii/Roamies/issues)
to get started, and report security problems as described in [SECURITY.md](SECURITY.md).

## Learn with me

Come build with me in my [Skool community](https://skool.com/kenkai). Get help, share what you're making, and learn how to get more out of AI.

## Star history

<a href="https://star-history.com/#KenKaiii/Roamies&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=KenKaiii/Roamies&amp;type=Date&amp;theme=dark">
    <img alt="Roamies star history chart" src="https://api.star-history.com/svg?repos=KenKaiii/Roamies&amp;type=Date">
  </picture>
</a>

<p align="center">If Roamies is useful to you, ⭐ star the repo so more people find it.</p>
