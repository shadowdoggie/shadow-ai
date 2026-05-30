# Shadow AI

**A Windows voice-first AI companion — think OpenClaw, but voice-only.**

Shadow AI is a hands-free, real-time voice assistant for Windows. You just talk to it,
naturally, and it talks back — while remembering you over time, searching the web, running
multi-step work in the background, and (optionally) working with your Google account.

> [!NOTE]
> **Platform: Windows only — by design.** Shadow AI is built for Windows and there are no
> plans for macOS, Linux, or mobile. This is a permanent stance, not a temporary limitation.

> *Shadow AI is an independent project, not affiliated with or endorsed by OpenClaw.
> "OpenClaw" is the trademark of its respective owner.*

## See it in action

▶️ **[Watch the demo](https://youtu.be/oXpQaCJPUO4)**

## What it does

- 🎙️ **Real-time voice conversation** — natural, low-latency back-and-forth, not push-to-talk.
- 🌍 **Speak any language** — talk to it in whatever language you like, even switching mid-sentence, and it keeps up.
- 🧠 **Long-term memory** — builds a personal memory graph about you and recalls it later.
- 🔎 **Web search** — looks things up live instead of guessing.
- 🤖 **Background subagents** — spins up agents to carry out multi-step tasks while you keep talking.
- 🛰️ **Proactive companion mode** — can chime in and react, with adjustable chattiness.
- ⏰ **Reminders & scheduling** — set things and get reminded, hands-free.
- 📅 **Optional Google Workspace** — Gmail, Calendar, Drive, and Contacts, using *your own* Google
  credentials (a guided in-app setup; fully optional and skippable).

## Getting started

**[⬇️ Download the latest installer](https://github.com/shadowdoggie/shadow-ai/releases/latest)** (`ShadowAI-Setup.exe`).

Shadow AI ships as a per-user Windows installer that bundles everything it needs — Python,
Node, and the SearXNG search engine — so there's **nothing else to install** (no Docker).
Run it, launch Shadow, and paste a free
[Gemini API key](https://aistudio.google.com/apikey) on first run — your key stays **local
on your machine**. Gmail/Calendar/Drive/Contacts are optional via an in-app setup wizard.

> [!NOTE]
> **Windows SmartScreen warning is expected.** The installer isn't code-signed yet (signing
> certificates are costly for a free, solo open-source project), so Windows may show a blue
> *"Windows protected your PC"* screen. This does **not** mean the file is unsafe — it just
> means it's new and unsigned. To proceed: click **More info → Run anyway**.
>
> Shadow AI is fully open source, so you can read exactly what it does. If you'd like to
> verify your download is the genuine, untampered file, check its SHA-256 hash against the
> value published on the [release page](https://github.com/shadowdoggie/shadow-ai/releases/latest):
>
> ```powershell
> Get-FileHash .\ShadowAI-Setup.exe -Algorithm SHA256
> ```
>
> v1.0.0 `ShadowAI-Setup.exe`:
> `67d69af21c3a7f345bd770b7ad1b667de9771d26fc087d13cd9c12f5c34073ee`

See **[SETUP.md](SETUP.md)** for full install, developer, and build-from-source steps.

## Contributing

Please read [`CONTRIBUTING.md`](CONTRIBUTING.md) first. In short:

- **Pull requests are not accepted** — this is a personal project built solely by its
  author, and PRs are closed automatically. Please don't prepare one.
- **Issues are welcome**, but there's no guarantee any will be read or actioned.
- Want changes? **Fork it** — it's open source under AGPL-3.0.

## License

Licensed under the **GNU Affero General Public License v3.0 or later** — see
[`LICENSE`](LICENSE). © shadowdoggie.

In short: you're free to use, study, modify, and share it, but any distributed or
network-hosted version (including forks) must remain open source under the same license.
