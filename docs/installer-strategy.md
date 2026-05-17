# Installer strategy — reducing install friction for non-developer historians

> Design doc, not an implementation. Scope: ClioDeck v2 (`feat/fusion-cliobrain`).
> Status: proposal. Owners: @inactinique. Target: ship with the v2.0 GA release.

## 1. Target user

**Persona: Claire, historian at a humanities faculty.**

- Runs macOS (Apple Silicon) or Windows laptop, sometimes a Linux workstation at work.
- Comfortable with Zotero, Word, a reference manager, maybe Obsidian.
- **Has never opened a terminal** and will not. "curl | sh" is a hard stop.
- Wants: double-click → use. Will tolerate a 2-minute download on first launch, not a 30-minute setup.
- Will churn at the first error message that mentions `node`, `npm`, `rebuild`, `homebrew`, `PATH`, or `port`.

Current painful path (README §Quick start):

1. Install Homebrew (macOS) or run `curl | sh` (Linux) to get Ollama.
2. `ollama pull nomic-embed-text` + a chat model (~2-5 GB). No progress UI in ClioDeck.
3. Download ClioDeck DMG/AppImage.
4. If building from source: native bindings for `better-sqlite3`, `hnswlib-node`, `node-llama-cpp` are rebuilt automatically via the `postinstall` hook.
5. For export to PDF: install Pandoc + a LaTeX distribution (MacTeX/TeX Live ~4 GB).

**Dropout happens at step 1 or 2.** We lose every non-dev user before they see the app.

## 2. Candidate install modes

### A. Fat native installer (everything embedded)

- DMG (mac, signed + notarized), NSIS (Windows, signed), AppImage + .deb (Linux).
- Embeds: Ollama binary, **one small local model** (Phi-3-mini Q4 ~2.3 GB, or Qwen2.5-0.5B ~400 MB as tiny fallback), `nomic-embed-text` (~270 MB), Pandoc binary (~30 MB), a minimal LaTeX (tectonic, ~20 MB self-bootstrapping) or defer LaTeX to first export.
- Total: **3-5 GB installer**.
- Pros: zero-network install, fully offline from minute 0, no "it works on my machine" support load.
- Cons: huge download, slow CI, model is frozen until app update, update churn (model re-shipped each release unless externalised).

### B. Slim installer + first-run download (**recommended**)

- Installer ~150-250 MB: app code, Pandoc, embedding model (small, mandatory for RAG).
- No chat model bundled. First-run wizard asks: **cloud** (paste key) or **local** (download Phi-3 with progress bar).
- Cloud default for users who already have an OpenAI/Anthropic key; the app works *immediately*.
- Local path: Ollama binary embedded, model pulled via in-app progress UI, cached under `userData/models/`.
- Pros: fast install, flexibility, small update deltas, we can rotate recommended model without a new release.
- Cons: requires network on first launch for local mode; needs a robust download/resume UI.

### C. Cloud-pure (zero runtime)

- Installer ~100 MB. No Ollama, no local model, no Pandoc (export via a cloud service or WeasyPrint-in-renderer fallback).
- User must provide a cloud LLM key.
- Pros: smallest binary, simplest support.
- Cons: breaks the "local-first" promise in the README; non-starter for historians handling sensitive archival material (GDPR, embargoed sources); export-to-PDF still needs *something*.

### Comparison

| Criterion              | A (fat)        | B (slim + pull)   | C (cloud-pure)   |
|------------------------|----------------|-------------------|------------------|
| Installer size         | 3-5 GB         | 150-250 MB        | ~100 MB          |
| Offline day 1          | Yes            | Cloud: no; local: after pull | No     |
| Matches "local-first"  | Yes            | Yes               | No               |
| Update cost            | High           | Low               | Lowest           |
| Time-to-first-token    | ~0             | Cloud 10 s / Local 5-15 min | Cloud 10 s |
| Sensitive-data safe    | Yes            | Yes (local mode)  | No               |
| CI / release pipeline  | Painful        | Reasonable        | Trivial          |

## 3. Recommendation

**Adopt mode B as the default**, with mode A available as an **"offline edition"** download for users with poor connectivity (doctoral schools, field research, archives without wifi).

Per-OS nuance:

- **macOS**: mode B, signed + notarized DMG. Universal binary (x64+arm64) via `build:mac-universal`. Ollama binary shipped as `extraResources`.
- **Windows**: mode B, signed NSIS (code-signing cert required; EV preferred to skip SmartScreen warning).
- **Linux**: mode B as AppImage + .deb (already configured). Flatpak is a later step — sandbox complicates the embedded-Ollama subprocess and model cache location.

Mode A ships as `ClioDeck-offline-<version>-<os>.<ext>` from the same CI with a `BUNDLE_MODELS=1` env var flag picked up by `electron-builder` to add the models to `extraResources`.

## 4. First-run wizard

Lives in `src/renderer/src/components/Onboarding/`. Trigger: no `config.json` at `userData` or `schema_version < 2`. Skippable via "Advanced → I know what I'm doing".

### Flow (4 steps, skippable at any point)

```
+------------------------------------------------------------+
| ClioDeck                                         (1/4)     |
|                                                            |
|   Welcome. Let's set up ClioDeck in under 2 minutes.       |
|                                                            |
|   Language:  ( ) Francais  (*) English                     |
|   Workspace: [ /Users/claire/Documents/ClioDeck   ] [...]  |
|                                                            |
|                                      [ Skip ]  [ Next > ]  |
+------------------------------------------------------------+
```

```
+------------------------------------------------------------+
| How should ClioDeck generate text?               (2/4)     |
|                                                            |
|   (*) Use a cloud model (fastest, needs an API key)        |
|       Provider: [ Anthropic Claude v ]                     |
|       API key:  [ sk-ant-...............     ] (hidden)    |
|       [ Test connection ]                OK / Failed: ...  |
|                                                            |
|   ( ) Run a model on my computer (private, offline)        |
|       We will download Phi-3-mini (~2.3 GB). Takes 5-15    |
|       min depending on your connection.                    |
|                                                            |
|   ( ) Skip — I will configure this later in Settings.      |
|                                                            |
|                               [ < Back ]       [ Next > ]  |
+------------------------------------------------------------+
```

```
+------------------------------------------------------------+
| Downloading local model...                       (3/4)     |
|                                                            |
|   Phi-3-mini-4k-instruct                                   |
|   [##############################........]   72%           |
|   1.65 GB / 2.3 GB   -   4.2 MB/s   -   ~2 min left        |
|                                                            |
|   You can keep using ClioDeck while this finishes.         |
|   [ Pause ]  [ Cancel and use cloud instead ]              |
+------------------------------------------------------------+
```

```
+------------------------------------------------------------+
| Optional integrations                             (4/4)    |
|                                                            |
|   [ ] Connect Zotero       (library path auto-detected)    |
|   [ ] Index an Obsidian vault    [ /path/to/vault ] [...]  |
|   [ ] Enable PDF export (we'll bundle Pandoc)    Done      |
|                                                            |
|                              [ < Back ]       [ Finish ]   |
+------------------------------------------------------------+
```

Defaults:

- Language: detect from OS locale (fr/en/de).
- Workspace: `~/Documents/ClioDeck` (created).
- LLM: **cloud / Anthropic** if no Ollama detected (cheapest time-to-value). Pre-populate `text-embedding-3-small` or `mistral-embed` for embeddings.
- If Ollama already installed and running on `:11434`: detect → select "local" + auto-fill.
- Telemetry: **off**. Mentioned once, never re-asked.

## 5. Bundling Ollama

**License**: MIT. Free to redistribute, including binaries. Add `licenses/Ollama-LICENSE.txt` to the DMG/NSIS license window (not strictly required by MIT but keeps attribution clean).

**Binaries** (pull from GitHub releases per arch at CI time):

- mac: `ollama-darwin` universal
- win: `ollama.exe` x64
- linux: `ollama-linux-amd64`, `ollama-linux-arm64`

Placed in `resources/bin/ollama/<platform>/` via a CI prebuild step, declared in `electron-builder.build.extraResources`.

**Runtime**: a new `src/main/services/embedded-ollama-service.ts` (design):

- On app ready, if user picked "local mode", spawn the binary as a child process.
- **Random free port** (avoid colliding with a user-installed Ollama on 11434). Write port to `userData/embedded-ollama.json`.
- Env: `OLLAMA_HOST=127.0.0.1:<port>`, `OLLAMA_MODELS=<userData>/models/ollama`.
- Lifecycle: typed state machine identical to `ProviderState` (`spawning | handshaking | ready | degraded | failed | stopped`). Consistent with the claw-code 6.1 convention already in use.
- Health: poll `GET /api/tags` until 200, then transition to `ready`.
- Shutdown: `SIGTERM` on `before-quit`, hard-kill after 3 s.
- Crash loop: exponential backoff, bail after 3 failures, surface a repair button in Settings.

**Model storage**: `app.getPath('userData')/models/ollama/` — survives app updates, not inside the `.asar`, user can wipe it manually to reclaim disk.

**Updates**:

- Ollama binary is updated with the app (shipped in each release via a small "ollama-version.json" manifest in resources; mismatch triggers re-extraction).
- Models update on demand: the Settings → LLM panel lists installed + available models, "Update" calls `POST /api/pull` through the existing provider abstraction. No auto-update (model pulls are too big to do silently).

**Detection of external Ollama**: if `11434` responds on startup, prefer the user's Ollama (assume they know what they're doing, avoid double memory usage). `provider-registry.ts` already abstracts this; only the bootstrap needs a quick probe.

## 6. Bundling Pandoc

**License**: GPL-2.0-or-later. **Implications** for distribution:

- ClioDeck itself is GPLv3 (README §License) — **compatible with GPLv2+**. Good.
- Source availability: we must offer Pandoc source (or a link to the upstream tarball) to recipients of the binary. Practical solution: ship `licenses/pandoc/COPYING` + `licenses/pandoc/SOURCE.txt` containing the upstream URL and commit hash. Document in the app's "About" pane.
- Distribution channels like the Mac App Store are **incompatible with GPL**. We already ship outside MAS (DMG direct download), so fine.

**Binaries**: official static releases from `jgm/pandoc`, ~30 MB per arch. Placed under `resources/bin/pandoc/<platform>/pandoc[.exe]`.

**LaTeX**: the painful dependency. Three options, decreasing order of preference:

1. **Tectonic** (MIT, ~20 MB, self-bootstraps missing packages on first export into `userData/tectonic-cache/`). Ship this; it is the realistic bundle target.
2. **WeasyPrint via a sidecar Python** — already have `backend/python-services/` tooling, but adds a Python runtime requirement.
3. **Fall back to HTML → PDF via Chromium** (Puppeteer is already a dep). Worse typography, but a zero-dep safety net.

Recommendation: tectonic as primary, Chromium/Puppeteer as fallback. Drop the MacTeX/TeX Live requirement entirely from the user's path.

## 7. Required code changes

Non-exhaustive task list. Each bullet is a discrete PR.

**Build / packaging**

- `package.json` → `build.extraResources`: add entries for `resources/bin/ollama/${os}` and `resources/bin/pandoc/${os}` plus `resources/bin/tectonic/${os}`.
- `package.json` → `build.asarUnpack`: add the new `resources/bin/**` so spawning works from a packaged app.
- `scripts/prepare-binaries.mjs` (new): CI prebuild that downloads + verifies SHA256 of Ollama / Pandoc / tectonic per target.
- `scripts/after-pack.cjs` (new): `chmod +x` the three binaries on mac/linux post-pack. Remember to wire it up via `build.afterPack` in `package.json`.
- GitHub Actions workflow: matrix build for mac-universal, win-x64, linux-x64, linux-arm64. Secrets for Apple notarisation + Windows signing. Publish `-offline` variant with `BUNDLE_MODELS=1`.

**Main process**

- `src/main/services/embedded-ollama-service.ts` (new): spawn, health, typed state, port allocation, shutdown.
- `src/main/services/embedded-pandoc-service.ts` (new): path resolution, version check, export shim.
- `src/main/services/pdf-export.ts`: accept an injected pandoc binary path; fall back to `PATH` lookup only in dev.
- `src/main/ipc/handlers/onboarding-handlers.ts` (new): `onboarding:detect-ollama`, `onboarding:start-model-download`, `onboarding:cancel-download`, `onboarding:get-progress` events.
- `src/preload/index.ts`: expose `window.electron.onboarding.*`.
- `backend/core/llm/providers/registry.ts`: `resolveOllamaEndpoint()` that prefers `127.0.0.1:<embeddedPort>` over env/default, with a clear fallback chain.
- `backend/core/llm/providers/ollama.ts`: read endpoint via the resolver (no behaviour change in tests).

**Renderer**

- `src/renderer/src/components/Onboarding/` (new): `OnboardingWizard.tsx`, `StepWelcome.tsx`, `StepLLM.tsx`, `StepModelDownload.tsx`, `StepIntegrations.tsx`, plus one `useOnboardingState` store (Zustand).
- `src/renderer/src/App.tsx`: gate on `hasCompletedOnboarding` (written to `config.json`).
- i18n: new keys in `public/locales/{fr,en}/common.json` under `onboarding.*`.
- Settings → "LLM" section: add a "Repair / redownload model" action that calls back into the same service.

**Tests**

- Vitest: state-machine tests for `embedded-ollama-service` (spawn → ready → stopped, crash → backoff → failed).
- Playwright: smoke test for the wizard (stub the download), verify `hasCompletedOnboarding` gate.

## 8. Rollout plan

### Stage 1 — MVP (target: v2.0 GA)

- Embedded Pandoc + tectonic, wired into `pdf-export.ts`. **Unblocks export for every user immediately.**
- Onboarding wizard steps 1, 2 (cloud path only), 4. The local-model step is disabled behind a feature flag.
- Detect externally-installed Ollama and use it; do not yet ship the binary.
- Ship two artefacts per OS: signed + notarised.
- Success metric: zero "how do I install Pandoc?" issues in the first 2 weeks.

### Stage 2 — Polish (v2.1)

- Embedded Ollama subprocess, random port, lifecycle service.
- Wizard step 3 fully functional: in-app model download with progress, pause, resume, cancel.
- Offline edition (`-offline` build, mode A) published alongside the slim build.
- Auto-update via `electron-updater` (separate from model updates).
- Telemetry-free crash reporting opt-in.

### Stage 3 — Edge cases and hardening (v2.2)

- Windows Defender / SmartScreen reputation building (EV cert if budget allows).
- Corporate proxies: proxy settings surfaced in the wizard, forwarded to the model downloader and cloud providers.
- Low-disk handling: refuse to start a model download if < 2× model size free, suggest a cache path change.
- Workspace v2 migration on first launch of an existing v1 install (separate from onboarding; gated on the Path A benchmark per ADR 0001).
- Air-gapped install guide: how to side-load a model tarball into `userData/models/ollama/`.
- Uninstall story: on Windows, NSIS uninstaller asks whether to keep `userData` (models, workspaces); on mac/linux, documented manual paths.

## Appendix — open questions

- Universal mac binary vs. per-arch DMGs (current config already emits both). Keep both; universal is the advertised default.
- Do we want a portable "no installer" zip for Windows users on locked-down lab machines? Probably yes at stage 3.
- Snap store for Linux? Low priority; AppImage + .deb covers the audience.
- Licence text aggregation: a single `ThirdPartyNotices.md` generated at build time from `node_modules` + embedded binaries.
