# Code Signing — decisions pending

> Parked for now. To revisit before v2.0 GA release.
> See also `docs/installer-strategy.md` for the broader distribution plan.

## Context

Without code signing:
- macOS: Gatekeeper blocks the app ("non-identified developer")
- Windows: SmartScreen warning on first launch
- Institutional MDM (university IT): may block unsigned apps entirely

## Open questions

### 1. Apple Developer Program
- Required for macOS notarization (99$/year)
- Do we have an account? If not, when to create one?

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
- A future ADR (to be written once decisions are made — note: ADR 0007 is now taken by the usage journal)
- `docs/installer-strategy.md`
