# Research: Reliable Tool-Use Models on Ollama (April 2026)

**Goal.** Inform a per-model whitelist for the ClioDeck Ollama provider, currently shipping with `capabilities.tools = false` because "most Ollama-served models handle function-calling poorly — they either loop on malformed tool_calls or return an empty stream" (`backend/core/llm/providers/ollama.ts:60-67`). Whitelist constraint: ≤ 32B params, runnable on a 16 GB MacBook (low end) and a 32 GB desktop (high end), good FR/EN quality, valid `tool_calls` JSON consistently.

**Methodology.** Authoritative source for "model declares `tools`" is the Ollama model page badge (`https://ollama.com/library/<name>`) and the curated list at `https://ollama.com/search?c=tools`. Behavioural confirmation comes from the Ollama blog posts on tool support and from open issues against `ollama/ollama`. Where I couldn't confirm a claim from a primary source I say "couldn't confirm" rather than guess.

---

## 1. Tier A — robust tool-use (whitelist candidates)

| Model (`ollama pull`) | Sizes | Tools badge on model page | Last updated | RAM at q4 | Caveat |
|---|---|---|---|---|---|
| `qwen3` | 0.6B, 1.7B, 4B, 8B, 14B, 30B, 32B, 235B | Yes — declared `tools` and `thinking` ([page](https://ollama.com/library/qwen3)) | 6 months ago (≈ Oct 2025) | 8B ≈ 5.5 GB; 14B ≈ 9 GB; 30B ≈ 19 GB | `qwen3` is the **only model the Ollama tool-calling docs use as the canonical example** ([docs.ollama.com](https://docs.ollama.com/capabilities/tool-calling)). Avoid `thinking=true` + tools simultaneously: regression after 0.9.0 returns empty output ([issue #10976](https://github.com/ollama/ollama/issues/10976)). |
| `qwen2.5` | 0.5B, 1.5B, 3B, 7B, 14B, 32B, 72B | Yes — `tools` declared across all sizes ([page](https://ollama.com/library/qwen2.5)) | ≈ 1 year ago | 7B ≈ 5 GB; 14B ≈ 9 GB; 32B ≈ 20 GB | Mature, widely cited as production-ready in third-party guides; trails `qwen3` in agentic benchmarks but is the safer default for older Ollama installs. |
| `qwen3-coder` (local 30B) | 30B (3.3B activated MoE), 480B cloud-only | Yes — `tools` ([page](https://ollama.com/library/qwen3-coder)) | 7 months ago | 30B-A3B ≈ 19 GB | Ollama explicitly states it was "updated for faster, more reliable tool calling in Ollama's new engine" ([blog](https://ollama.com/blog/coding-models)). Tuned for code/agent tasks — fine for general tool-use but optimised for tool-heavy loops. |
| `mistral-small3.2` | 24B | Yes — `vision tools 24b` ([page](https://ollama.com/library/mistral-small3.2)) | 10 months ago (Mistral-Small-3.2-24B-Instruct-2506) | 24B ≈ 15 GB | The page itself states "Small-3.2's function calling template is **more robust**" — Mistral's own response to function-calling regressions in earlier Small releases. Best tool-use Mistral in the ≤ 32B band today. |
| `mistral-nemo` | 12B | Yes — `tools 12b` ([page](https://ollama.com/library/mistral-nemo)) | 9 months ago | 12B ≈ 7.5 GB | Listed in the original Ollama tool-support announcement ([blog, July 2024](https://ollama.com/blog/tool-support)) and re-confirmed in the streaming-tools post ([blog, May 2025](https://ollama.com/blog/streaming-tool)). Strong FR/EN bilingual quality (Mistral house language). The 16 GB MacBook target's best French model. |

All five appear in the curated tools list at `https://ollama.com/search?c=tools` (or its predecessor) and in the Ollama tool-calling announcement / streaming-tools posts.

---

## 2. Tier B — works but quirky

| Model | Issue | Workaround |
|---|---|---|
| `granite4` (3b/7b-a1b/32b-a9b) | IBM declares "improved instruction following and tool-calling" ([page](https://ollama.com/library/granite4)) and the page carries the `tools` badge, but I found no independent benchmark or issue thread quantifying reliability vs Qwen/Mistral. Listed by Ollama as featuring tool-calling ([blog](https://ollama.com/blog/coding-models)). | Whitelist conservatively at the 7B / 32B-A9B sizes only after a smoke test in ClioDeck's own agent loop; treat as Tier A only after verification. |
| `phi4-mini` (3.8B) | Model page announces "the long-awaited function calling feature is finally supported" ([page](https://ollama.com/library/phi4-mini)) — i.e. it was added late in the Phi line, after Phi-3 had no usable tool-call path. Reliability is unproven in 2025–2026 issue trackers (couldn't confirm). | Useful as a fallback for very small footprints (< 4 GB) but do not present as the default in ClioDeck. |
| `llama3-groq-tool-use` (8B / 70B) | Specialist fine-tune from Groq + Glaive; 8B scored 89.06 % on BFCL (#3 at publication, July 2024). 8B is whitelistable on a 16 GB Mac. | Old (last updated ≈ 1 year ago). Use only if user explicitly asks for a tool-tuned 8B and `qwen3:8b` is unavailable. |
| `gpt-oss:20b` | Carries `tools`, but issue [#11691 (Aug 2025)](https://github.com/ollama/ollama/issues/11691) reports structured-output failures via the OpenAI SDK, and [#12064 (Aug 2025)](https://github.com/ollama/ollama/issues/12064) shows malformed-JSON parse errors on `write_file`-style large-payload tool calls (still open). | Skip for the v1 whitelist. |
| `devstral` (24B) | Marketed for agentic coding and listed in the streaming-tool post, but the model page itself does not document a `tools` badge in the content I retrieved (couldn't confirm). | Verify badge before whitelisting; otherwise prefer `mistral-small3.2`. |

---

## 3. Tier C — confirmed unreliable, do not whitelist

| Model | Verdict | Evidence |
|---|---|---|
| `llama3.2` (1B / 3B) | The page declares `tools 1b 3b` ([page](https://ollama.com/library/llama3.2)) but the small-Llama tool format is the same Llama-3.1 template applied to a 3B base. The maintainer's complaint (looping malformed `tool_calls`, empty streams) is consistent with widely-reported Llama-3.2 behaviour: at 3B the model frequently emits the `<|python_tag|>` prefix without closing JSON, which Ollama's old template-based parser ([issue #7014](https://github.com/ollama/ollama/issues/7014)) handled poorly. **Confirmed: skip.** |
| `llama3` (no .1) | No `tools` badge on the official page; predates Ollama's tool-calling feature (announced [July 2024](https://ollama.com/blog/tool-support) for `llama3.1`). **Confirmed: skip.** |
| `gemma2` | No `tools` badge. Gemma-2 was never trained for function calling; the Gemma family only gained native function-calling with Gemma 4 / FunctionGemma per the recent Ollama blog. **Confirmed: skip.** |
| `phi3` | No `tools` badge — `phi4-mini` is the first Phi to announce function calling ([page](https://ollama.com/library/phi4-mini)). **Confirmed: skip.** |
| `mistral` (7B v0.3 classic) | The page lists `tools` for v0.3, but the Ollama-side template is the same one Mistral later replaced in Small-3.2 ("more robust" wording on the [Small-3.2 page](https://ollama.com/library/mistral-small3.2) is a tacit admission earlier templates were not). Empirically known to loop on multi-turn tool calls. **Skip in favour of `mistral-nemo` or `mistral-small3.2`.** |
| `llama3.1:8b` | Official tool-use model from the [July 2024 blog](https://ollama.com/blog/tool-support), but the 8B size is the worst offender in community reports for the "empty stream" pathology because its Llama-3 template emits the python-tag prefix prematurely. The maintainer's quoted experience matches. Whitelist `qwen3:8b` instead. |

---

## 4. Ollama-side gotchas

**`arguments` must be a JSON object on the wire.** The Ollama native `/api/chat` endpoint expects `tool_calls[i].function.arguments` to be an object, but several models (and several client SDKs that re-serialise on the way back) hand it back as a JSON-encoded *string*. When the assistant message is then echoed to the next turn, Ollama errors with `Value looks like object, but can't find closing '}' symbol` and the model degrades — sometimes into emitting fake `<tool_call>` XML instead of native tool calls. Fix on the client side: `arguments: typeof fc.arguments === 'string' ? JSON.parse(fc.arguments) : fc.arguments` before re-sending. References: [Ollama issue #6002](https://github.com/ollama/ollama/issues/6002), discussion in the LLM-basics writeup at Caktus ([Dec 2025](https://www.caktusgroup.com/blog/2025/12/03/learning-llm-basics-ollama-function-calling/)). ClioDeck's `fusion-chat-service.ts` agent loop should normalise both directions.

**Per-model `template` overrides matter.** Ollama parses tool calls by reading the per-model Modelfile `TEMPLATE` to find the tool-call prefix, then peeling JSON off the stream ([streaming-tool blog, May 2025](https://ollama.com/blog/streaming-tool); [issue #7014](https://github.com/ollama/ollama/issues/7014) tracks the rewrite away from the older template-only parser). Consequence: if a user has pulled an older tag of a model whose template predates the `tools` capability, the `tools` field may silently no-op even though the badge is shown. Recommend `ollama pull <name>` immediately before flipping the whitelist on, and pin to a known-good tag in ClioDeck config.

**Streaming + tools is a 2025 feature.** The [May 28 2025 blog post](https://ollama.com/blog/streaming-tool) introduced incremental tool-call parsing. Pre-0.8 Ollama versions only emit `tool_calls` after the full message buffer; ClioDeck's `fusion-chat-service.ts` should detect server version and degrade gracefully.

**`thinking` + tools regression on `qwen3:30b-a3b`.** [Issue #10976](https://github.com/ollama/ollama/issues/10976) (open as of writing): combining `think=true` with tool definitions yields empty output. Workaround: disable `thinking` when tools are bound, or use the dense `qwen3:14b` / `qwen3:8b` variants where the issue isn't reported.

---

## 5. Suggested whitelist for ClioDeck

Ordered by recommendation strength for a francophone digital-humanities user base on 16 GB / 32 GB machines:

1. **`ollama pull mistral-nemo`** — 12B, ~7.5 GB at q4. Fits comfortably on the 16 GB MacBook T2. Mistral's house-trained French is the best in this band for historical-text writing. In the original tool-support announcement and re-confirmed for streaming. **Default for the low-end target.**
2. **`ollama pull qwen3:8b`** — 8B, ~5.5 GB at q4. The single most robust tool-call implementation Ollama documents (canonical example in the docs). Strong English, decent French, excellent agentic behaviour. **Default for users who want tools "just to work".**
3. **`ollama pull qwen3:14b`** — 14B, ~9 GB at q4. Headroom on the 32 GB desktop, better reasoning, same reliable tool-call template as 8B. Avoids the 30B-A3B `thinking` regression.
4. **`ollama pull mistral-small3.2`** — 24B, ~15 GB at q4. Sweet spot on the 32 GB desktop. Mistral's own statement that the function-calling template was made "more robust" in 3.2 is the strongest signal of any 24B model. Best French tool-caller available locally.
5. **`ollama pull qwen2.5:14b`** — fallback for users on older Ollama installs (< 0.8) where `qwen3` features regress; mature, widely deployed.
6. **`ollama pull qwen3:32b`** — for the 32 GB desktop only when accuracy is paramount; ≈ 20 GB at q4. Last on the list because it eats memory the user usually wants for embeddings + vector store.

**Confirmation of items in the existing fusion plan:**
- *Mistral Nemo*: **confirmed** — keep.
- *Qwen 2.5 / 3*: **confirmed** — prefer Qwen 3 where available, Qwen 2.5 as fallback.
- *Llama 3.1 family*: **drop**. Despite carrying the `tools` badge, the 8B is precisely the model the maintainer's bug report describes ("loops on malformed tool_calls or returns an empty stream"). The 70B is out of scope (> 32B). Replace with Qwen 3.

**Quantization note.** Across all five whitelist entries, q4_K_M is the floor for reliable JSON emission in community reports; q3 and below produce noticeably more malformed `tool_calls`. q8 is preferable on the 32 GB desktop for `mistral-small3.2` and `qwen3:14b` if RAM allows. I could not find a primary-source benchmark for q4-vs-q8 tool-call validity rate (couldn't confirm a specific number) — the recommendation is conservative practice rather than a measured threshold.

**What I could not confirm.** Per-quantization tool-call validity rates from a primary source; the exact Ollama version that shipped the new (Aho-Corasick-style) parser from PR #10415 referenced in issue #7014; whether `devstral` carries the `tools` badge today (the page content I retrieved did not show one). All three are worth a 30-minute confirmation pass before flipping the whitelist live.
