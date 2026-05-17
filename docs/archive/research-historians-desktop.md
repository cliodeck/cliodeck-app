# Research note — Greenstreet's "Historian's Desktop" and what it implies for ClioDeck

> Source: Mark Greenstreet, *The Historian's Desktop*, Generative Lives (Substack)
> URL: https://generativelives.substack.com/p/the-historians-desktop
> Read: 2026-04-30

## 1. The article in one paragraph

Greenstreet (UK historian) describes a Claude Desktop–based research environment with three layers:

1. **Skills** — markdown + YAML components organised in six categories (archival access, document processing, metadata, monitoring, project management, *Socratic partnership*), auto-activated when a query matches a YAML trigger.
2. **MCPs** — domain archives like Old Bailey Online, Virtual Treasury of Ireland, Riksarkivet, paired with "interview skills" that tailor the dialogue to each archive.
3. **Governance** — a top-level `CLAUDE.md` plus per-area `RULES.md` files, framed as plain-English methodology baked into the tool.

Notably, the article never mentions Zotero, Tropy, or Obsidian — Greenstreet positions the Desktop as a **new category**, not a successor to existing historian software.

## 2. Where ClioDeck already overlaps

| Greenstreet's piece | ClioDeck today |
|---|---|
| Skills (YAML + markdown) | Recipes (`backend/recipes/`, zod-typed YAML) |
| Master `CLAUDE.md` / `RULES.md` | `.cliohints` (`.cliodeck/v2/hints.md`) |
| Archive MCPs | 9 MCP tools — Gallica, Europeana, HAL, Zotero, Tropy, Obsidian, Documents, Graph, EntityContext |
| Socratic partnership | Brainstorm mode (the whole `feat/fusion-cliobrain` thrust) |
| "Designed by historians for historians" | Same audience, same framing — but ClioDeck wraps *existing* DH tools instead of replacing them |

## 3. Suggestions worth considering

### 3.1 Add a `triggers:` field to recipes for auto-activation
Greenstreet's strongest UX move is recipes that fire silently when the user's question matches a pattern, instead of being explicitly invoked. `RecipeStepSchema` in `backend/recipes/schema.ts` would need a top-level `triggers: string[]` (keywords or regex) plus a matcher in `runner.ts`. Low cost, big "magic" payoff for non-technical historians.

### 3.2 Ship a "skill builder" panel
Recipes today require editing YAML in `.cliodeck/v2/recipes/`. The article's most accessible feature is an interactive builder. A small Config-style panel that scaffolds the YAML (pick mode, pick inputs, pick MCP tool calls) would lower the barrier dramatically and matches the goose "make extension holes explicit" lesson already cited in `backend/recipes/schema.ts`.

### 3.3 Layer `.cliohints` the way Greenstreet layers governance
Right now `hints.md` is a single file. Splitting into sections (Purpose, Safety, Naming, Style, Workstreams) — even if rendered as one prompt — gives historians a vocabulary for *what* to put in hints. Greenstreet treats this as the differentiator vs. raw Claude.

### 3.4 Curate domain-archive MCPs as a community surface
ClioDeck already has Gallica/Europeana/HAL (French/EU bias). Greenstreet's list (Old Bailey, Riksarkivet, Virtual Treasury of Ireland, Ottoman gazettes) suggests an open registry for community-contributed archive MCPs. The pattern in `backend/mcp-server/tools/searchGallica.ts` is already the right template — what's missing is discoverability. See also `docs/archive-mcp-connectors.md`.

### 3.5 Pair each archive MCP with an "interview" recipe
Greenstreet's insight is that an archive MCP alone is just a search box; pairing it with a Socratic skill that knows the archive's structure (e.g., Old Bailey's defendant/judge/charge schema) is what makes it usable. For ClioDeck this could be a recipe-per-MCP convention shipped under `backend/recipes/builtin/`.

### 3.6 Defensive note — don't dilute the integration story
Greenstreet ignores Zotero/Tropy/Obsidian. ClioDeck's moat is exactly that it wraps them. The fusion-cliobrain plan is right to keep that center-of-gravity; the suggestions above are about borrowing Greenstreet's **packaging** (skills, triggers, governance vocabulary), not his **scope** (replace everything with Claude Desktop).

## 4. Recommended pickup order

The lowest-risk, highest-signal pickups are **3.1 (recipe triggers)** and **3.2 (skill builder)** — both extend the existing recipe system without touching the provider contract or HNSW format flagged as "do not touch" in `CLAUDE.md`.
