<div align="center">

# 🎙️ Shadow AI

### A Windows voice-first AI companion — think OpenClaw, but voice-only.

Hands-free, real-time voice. Long-term memory. Web search. Background agents. Your Google account, optionally.

[![Download](https://img.shields.io/badge/download-latest-2ea043?logo=windows&logoColor=white)](https://github.com/shadowdoggie/shadow-ai/releases/latest)
[![Downloads](https://img.shields.io/github/downloads/shadowdoggie/shadow-ai/total?logo=github&color=blue)](https://github.com/shadowdoggie/shadow-ai/releases)
[![Stars](https://img.shields.io/github/stars/shadowdoggie/shadow-ai?style=flat&logo=github&color=yellow)](https://github.com/shadowdoggie/shadow-ai/stargazers)
[![License: AGPL v3](https://img.shields.io/badge/License-AGPL%20v3-orange.svg)](LICENSE)
[![Platform: Windows](https://img.shields.io/badge/platform-Windows-0078D6?logo=windows)](#getting-started)

**[⬇️ Download](https://github.com/shadowdoggie/shadow-ai/releases/latest) · [▶️ Watch the demo](https://youtu.be/oXpQaCJPUO4) · [🛠️ Setup & build](SETUP.md)**

<sub><em>Independent project — not affiliated with, endorsed by, or sponsored by OpenClaw. "OpenClaw" and any related names are trademarks of their respective owners; any reference is nominative (for comparison/description) only.</em></sub>

</div>

---

<div align="center">

### ▶️ See it in action

[![Watch the Shadow AI demo](https://img.youtube.com/vi/oXpQaCJPUO4/maxresdefault.jpg)](https://youtu.be/oXpQaCJPUO4)

*(click the thumbnail to watch on YouTube)*

</div>

---

## ✨ What it does

- 🎙️ **Real-time voice conversation** — natural, low-latency back-and-forth, not push-to-talk.
- 👁️ **Screen vision** — share your screen and it can see and talk about what's on it.
- 🌍 **Any language** — talk in whatever language you like, even switching mid-sentence, and it keeps up.
- 🧠 **Long-term memory** — builds a personal memory graph about you and recalls it later.
- 🔎 **Live web search** — looks things up instead of guessing.
- 🤖 **Background subagents** — spins up agents to carry out multi-step tasks while you keep talking.
- 🛰️ **Proactive companion mode** — can chime in and react, with adjustable chattiness.
- ⏰ **Reminders & scheduling** — set things and get reminded, hands-free.
- 📅 **Optional Google Workspace** — Gmail, Calendar, Drive, and Contacts using *your own* Google credentials (guided in-app setup, fully optional).
- 🔌 **Your choice of model** — background subagents can run on **Gemini**, **OpenAI Codex**, **MiniMax**, **Canopy Wave (Kimi)**, **Ollama Cloud**, or **any custom OpenAI-compatible endpoint** (a paid API or your own gateway).

> [!NOTE]
> **Platform: Windows only — by design.** Shadow AI is built for Windows and there are no
> plans for macOS, Linux, or mobile. This is a permanent stance, not a temporary limitation.

---

## 🚀 Getting started

**[⬇️ Download the latest installer](https://github.com/shadowdoggie/shadow-ai/releases/latest)** (`ShadowAI-Setup.exe`).

Shadow AI ships as a per-user Windows installer that bundles everything it needs — Python,
Node, and the SearXNG search engine — so there's **nothing else to install** (no Docker).
Run it, launch Shadow, and paste a free
[Gemini API key](https://aistudio.google.com/apikey) on first run — your key stays **local on
your machine**. Gmail/Calendar/Drive/Contacts are optional via an in-app setup wizard.

> [!NOTE]
> **Windows SmartScreen warning is expected.** The installer isn't code-signed yet (signing
> certificates are costly for a free, solo open-source project), so Windows may show a blue
> *"Windows protected your PC"* screen. This does **not** mean the file is unsafe — it just
> means it's new and unsigned. To proceed: click **More info → Run anyway**.
>
> Shadow AI is fully open source, so you can read exactly what it does. To verify your download
> is the genuine, untampered file, check its SHA-256 against the value on the
> [release page](https://github.com/shadowdoggie/shadow-ai/releases/latest):
>
> ```powershell
> Get-FileHash .\ShadowAI-Setup.exe -Algorithm SHA256
> ```
>
> v1.8.1 `ShadowAI-Setup.exe`:
> `57231c96e341f98d0fd71a63878f2ee27ee9d10e7c685219868996838dd58117`

See **[SETUP.md](SETUP.md)** for full install, developer, and build-from-source steps.

---

## ⭐ Star the project

If Shadow AI is useful to you, please **[star the repo](https://github.com/shadowdoggie/shadow-ai/stargazers)** — it's a free, one-click way to support a solo open-source project and help others find it.

[![Star History Chart](https://api.star-history.com/svg?repos=shadowdoggie/shadow-ai&type=Date)](https://star-history.com/#shadowdoggie/shadow-ai&Date)

---

## 🤝 Contributing

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. In short:

- **Pull requests are not accepted** — this is a personal project built solely by its author, and PRs are closed automatically. Please don't prepare one.
- **Issues are welcome**, but there's no guarantee any will be read or actioned.
- Want changes? **Fork it** — it's open source under AGPL-3.0.

## 📄 License

Licensed under the **GNU Affero General Public License v3.0 or later** — see [`LICENSE`](LICENSE). © shadowdoggie.

In short: you're free to use, study, modify, and share it, but any distributed or network-hosted
version (including forks) must remain open source under the same license.
