# Code Signing — decisions pending

> Still open, and still the blocker for v2.0 GA. **macOS is tracked in
> issue [#75](https://github.com/cliodeck/cliodeck-app/issues/75)**: the
> Apple Developer account exists (team `56789J6QWG`) and notarization is wired
> through electron-builder's built-in `mac.notarize: true` — no `afterSign` hook.
> Procedure: [`macos-notarization.md`](macos-notarization.md). This document
> keeps the questions that #75 does *not* answer: Windows, Linux, and the
> CI-versus-local signing choice.
>
> See also `docs/installer-strategy.md` for the broader distribution plan.

## Where the build config already stands

`package.json`'s `mac` block carries `hardenedRuntime: true`,
`entitlements` + `entitlementsInherit`, `gatekeeperAssess: false` and
`notarize: true`. Signing and notarization happen on a maintainer's Mac
that holds the Developer ID certificate and a `notarytool` keychain profile;
without them the build silently comes out unsigned. No CI secret yet.

## Context

Without code signing:
- macOS: Gatekeeper blocks the app ("non-identified developer")
- Windows: SmartScreen warning on first launch
- Institutional MDM (university IT): may block unsigned apps entirely

## Open questions

### 1. Apple Developer Program
- Required for macOS notarization (99$/year)
- Account created (2026-09-15, team `56789J6QWG`); wiring done, see
  [`macos-notarization.md`](macos-notarization.md).

### 2. Windows signing
Options:
- (a) EV Code Signing Certificate (~300-500$/year) — immediate SmartScreen trust
- (b) Standard Code Signing Certificate (~100$/year) — trust builds over time
- (c) No Windows signing for v2 — accept SmartScreen warning

### 3. Linux
- AppImage has no OS-level signature requirement
- GPG signing for admin verification — useful or overkill?

### 4. CI/CD
- Automated signing in GitHub Actions (requires secrets in CI)?
- Or manual signing on local machine before each release?

## Related
- A future ADR (to be written once decisions are made — the next free number is **0008**)
- Issue [#75](https://github.com/cliodeck/cliodeck-app/issues/75) — macOS signing + notarization
- `docs/installer-strategy.md`
