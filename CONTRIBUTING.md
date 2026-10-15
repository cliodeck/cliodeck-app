# Contributing to ClioDeck

Thank you for your interest in ClioDeck.

*Vous pouvez écrire en français, in English, oder auf Deutsch.*

## Project status

ClioDeck is an experimental research tool for historians. It is designed and maintained by a single person, alongside teaching and research duties, and developed with an AI coding assistant ([Claude Code](https://claude.ai/code); the conventions it follows are public in [`CLAUDE.md`](CLAUDE.md)).

The 1.0 release will stabilise what already exists rather than add to it. ClioDeck nevertheless remains an experimental tool, not a finished product: **keep backups of any project you open with it**.

Because of this, contributions are accepted in the forms listed below only. Everything else is closed for now. This is a choice about what one maintainer can review well, not a judgment on the quality of your work. Projects such as SQLite and Litestream have made the same choice for the same reason.

## What is not accepted (for now)

- **Pull requests that were not invited.** This includes bug fixes, new features, refactors, dependency upgrades, formatting changes and translations. They will be closed without review.
- **Feature requests as commitments.** You are welcome to describe a need in the [*Ideas* category](https://github.com/cliodeck/cliodeck-app/discussions/categories/ideas) of Discussions, but there is no promise it will be implemented.
- **Support requests about third-party tools** (Zotero, Tropy, Obsidian, Ollama, model providers). Please use their own channels.

**When this may change.** After the 1.0 release, I will consider opening the project to small bug-fix pull requests that come with a test. Any change to this policy will be announced here.

## What is welcome

### 1. Bug reports

Using ClioDeck on a real research task and telling me what breaks is the most useful contribution. The bugs that matter most are often silent: nothing crashes, but a result is wrong and looks plausible (a missing source, a wrong page number, a bibliography entry that disappeared). Please report those too.

Open an [issue](https://github.com/cliodeck/cliodeck-app/issues/new/choose) and include:

- the ClioDeck version (*Help → About ClioDeck*) and your operating system;
- the AI setup: local (Ollama or embedded model, and which model) or a cloud provider;
- what you did, what you expected, what happened instead;
- the kind of corpus involved (number of documents, languages, OCR quality), **not the documents themselves**;
- if relevant, an excerpt of the logs (see below), after checking it contains no personal or sensitive information.

**Logs.** If ClioDeck crashed, a log is written to `~/.cliodeck-crash.log`. Otherwise, *View → Toggle Developer Tools → Console* shows the interface's messages. Logs often contain file names and paths: check them before posting.

**Never attach a project's `.cliodeck/` folder.** Its database (`brain.db`) holds the full text of your sources, your notes and your chat history. If a file is needed, I will ask for something specific.

Please do not attach private, unpublished or sensitive archival material. If you can reproduce the problem on a public-domain corpus, say so: it makes the report much easier to act on.

### 2. Usability feedback

What was confusing, where you hesitated, what you gave up on, when you doubted what the application was showing you: this is as valuable as a bug report. Post it in the [*Feedback* category](https://github.com/cliodeck/cliodeck-app/discussions/categories/feedback) of Discussions.

### 3. Testing ClioDeck over time

I am looking for a small number of historians willing to use ClioDeck on a real project over several weeks and to report regularly. If that is you, say so in the [*Testing* category](https://github.com/cliodeck/cliodeck-app/discussions/categories/testing) of Discussions, with a few words about your research and your corpus (Zotero library, Tropy archive, Obsidian vault…).

### 4. Modes

The assistant's *modes* (*Settings*, switched to *Expert*, then *Modes*) are profiles combining a system prompt, generation parameters and retrieval settings: *Literature Review*, for instance. A mode is a single JSON file (format version `1.0`); the easiest way to create one is to duplicate an existing mode, then edit the file it saves in `~/.config/cliodeck/modes/`. A mode must provide its name, description and system prompt in both French and English.

Modes can be shared without going through me: post the JSON file in the [*Modes and recipes* category](https://github.com/cliodeck/cliodeck-app/discussions/categories/modes-and-recipes) of Discussions, and anyone can load it with *Settings → Expert → Modes → Import a mode*. There is no official catalogue, and shared modes are **not** reviewed. Some may be added to the built-in modes, at my discretion.

### 5. Recipes

Recipes are YAML workflows that chain steps (`brainstorm`, `search`, `graph`, `write`, `export`). Built-in recipes live in [`backend/recipes/builtin/`](backend/recipes/builtin/); your own go in your project's `.cliodeck/recipes/` folder, where ClioDeck can also edit them. The format is still young (for instance, `export` only produces PDF): it may evolve, and a recipe may then need adjusting.

Recipes are shared like modes: post the YAML file in Discussions, under the same rules.

## How to propose a mode or a recipe

1. **Open a Discussion**, in the *Modes and recipes* category. Do not open a pull request.
2. Include:
   - a name and a one-sentence purpose;
   - the research task it addresses and the kind of user it is for;
   - the full file (JSON or YAML);
   - the language(s) it works in;
   - which model(s) you tested it with, and on which **public** corpus;
   - an example run (redacted if needed) and the failure modes you noticed.
3. If I would like to add it to ClioDeck, I will either integrate it myself or invite a pull request limited to [`backend/recipes/builtin/`](backend/recipes/builtin/). Pull requests that were not invited, or that touch other files, will be closed.

### Criteria for inclusion in ClioDeck

A mode or recipe can be added to the built-in ones if it:

- does what it says, and is documented well enough to be understood without you;
- is self-contained and small;
- does not require non-public data, credentials or API keys (never include secrets in a proposal);
- does not reproduce substantial copyrighted text, and credits any work it derives from.

### Before using someone else's mode or recipe

Modes and recipes are instructions given to a language model, and they act on your project:

- a mode replaces the assistant's system prompt and can change which sources are searched;
- a recipe sends excerpts of your corpus to the model you have configured: if that model runs in the cloud, ClioDeck asks for your consent first;
- a recipe's `export` step writes a file to the path the recipe names.

Read any mode or recipe written by someone else before using it on sensitive material. This applies to the built-in ones too.

## AI-assisted contributions

ClioDeck itself is developed with an AI coding assistant, so using AI tools to draft a mode, a recipe or a bug report is fine, provided you say so and have tested the result yourself. Unverified, machine-generated proposals will be closed.

## Licence

ClioDeck is released under the [GNU General Public License, version 3 or later](LICENSE).

Modes and recipes posted in Discussions are dedicated to the public domain under [CC0 1.0](https://creativecommons.org/publicdomain/zero/1.0/): by posting one, you agree that anyone, including ClioDeck, may reuse, modify and redistribute it without conditions. If you cannot agree to this (because your mode or recipe derives from someone else's work, for instance), say so in your post.

## Response times

ClioDeck is a side project. There is one maintainer, whose availability depends on many factors (teaching, research, administration, life). I usually go through issues and discussions on **Friday mornings (Central European Time)**, but not every week. A long silence is not a rejection. Inactive issues and discussions may be closed after a few weeks; you can reopen them.

## Conduct

Be courteous and assume good faith. Comments that are hostile to people, rather than critical of the software, will be removed.

## Security

If you find a vulnerability, please do not open a public issue. Use GitHub's [private vulnerability reporting](https://github.com/cliodeck/cliodeck-app/security/advisories/new) instead.
