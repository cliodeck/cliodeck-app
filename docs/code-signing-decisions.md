# Code Signing — decisions pending

> Still open, and still the blocker for v2.0 GA. **macOS is now tracked in
> issue [#75](https://github.com/cliodeck/cliodeck-app/issues/75)**, which
> carries the wiring plan (`@electron/notarize` + an `afterSign` hook + CI
> secrets) and is blocked only on the maintainer's Apple Developer ID
> certificate. This document keeps the questions that #75 does *not* answer:
> Windows, Linux, and the CI-versus-local signing choice.
>
> See also `docs/installer-strategy.md` for the broader distribution plan.

## Where the build config already stands

`package.json`'s `mac` block is **prepared but inert**: `hardenedRuntime: true`,
`entitlements` + `entitlementsInherit`, `gatekeeperAssess: false`. There is no
`afterSign` hook, no signing identity, and no CI secret — so distributed builds
still trip Gatekeeper.

## Context

Without code signing:
- macOS: Gatekeeper blocks the app ("non-identified developer")
- Windows: SmartScreen warning on first launch
- Institutional MDM (university IT): may block unsigned apps entirely

## Open questions

### 1. Apple Developer Program
- Required for macOS notarization (99$/year)
- Do we have an account? If not, when to create one?
- **This is the one live blocker** — see issue #75 for the prerequisites
  (Developer ID Application certificate, App Store Connect API key) and the
  small PR that follows once they exist.

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
