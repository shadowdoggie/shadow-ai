# Shadow AI Architecture Notes

Shadow AI is a local browser app served by `run.ps1`.

## Runtime Pieces

- `run.ps1` starts the local HTTP server, exposes local APIs, handles Google OAuth, and serves `src`.
- `src/index.html` loads the browser runtime from `src/scripts` in a fixed order.
- `scheduler.js` runs reminders and scheduled tasks on port `9333`.
- `browser_controller.js` runs Playwright browser automation on port `9222`.
- `skills/` contains local reusable user workflow instructions.
- `tests/` contains Vitest checks for scheduler and voice interruption behavior. Keep it unless the test tooling is intentionally removed too.

## Local Private Data

Private app data that can contain API keys or OAuth secrets lives in `secrets/`, which is ignored by git.

Current private files:

- `secrets/config.json`
- `secrets/google_credentials.json`
- `secrets/google_tokens.json`
- optional Google OAuth imports like `secrets/credentials.json` or `secrets/client_secret.json`

`run.ps1` migrates legacy root-level copies of these files into `secrets/` when the app starts.

## Runtime Profiles

Browser profile data lives in ignored runtime folders:

- `runtime/profiles/shadow_app` - Chrome app profile for the main Shadow window.
- `runtime/profiles/browser_controller` - Playwright/browser automation profile so logins can persist.

These folders can be deleted to reset browser state, but deleting them may clear local browser storage or saved logins.

## Browser Script Map

See `src/scripts/README.md` for the ordered script map. The files are classic scripts, not ES modules, so globals are intentionally shared across files.

## Development Commands

- Start the app: `npm start`
- Run tests: `npm test`
