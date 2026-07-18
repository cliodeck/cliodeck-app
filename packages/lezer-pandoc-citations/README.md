# @cliodeck/lezer-pandoc-citations

[Pandoc citation](https://pandoc.org/MANUAL.html#citation-syntax) extension
for the [Lezer Markdown parser](https://github.com/lezer-parser/markdown):
`[@key]`, locators (`[@key, p. 12]`), clusters (`[@a; @b, pp. 101-103]`),
prefixes/suffixes (`[see @key, p. 33]`) and bare `@key` citations — with an
email-address guard. Works with CodeMirror 6 via `@codemirror/lang-markdown`
and with any `@lezer/markdown` consumer.

To our knowledge the first Lezer extension for Pandoc citations. Extracted
from [ClioDeck](https://github.com/cliodeck/cliodeck-app), a desktop writing
environment for historians, where it powers live-rendered citation pills,
Zotero-backed autocompletion and unresolved-key linting. Battle-tested
against a fixture corpus (clusters, escaped `\[@key\]` artifacts, emails,
code-block false positives, citations inside tables and blockquotes).

## Install

```
npm install @cliodeck/lezer-pandoc-citations
```

Peer dependencies: `@lezer/markdown` ≥ 1, `@lezer/highlight` ≥ 1.

## Usage

With CodeMirror 6:

```js
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { PandocCitations } from '@cliodeck/lezer-pandoc-citations';

markdown({ base: markdownLanguage, extensions: [PandocCitations] });
```

## Syntax tree

```
[see @lester1932, p. 33; @clavert2013]

PandocCitation
├─ CitationMark "["
├─ CitationPrefix "see "
├─ CitationMark "@"
├─ CitationKey "lester1932"
├─ CitationSuffix ", p. 33"
├─ CitationMark ";"
├─ CitationMark "@"
├─ CitationKey "clavert2013"
└─ CitationMark "]"
```

Bare citations parse as `PandocCitation[CitationMark, CitationKey]`.
Keys match `[A-Za-z0-9_:-]+` (Pandoc-compatible).

Known v1 limits (documented in the source): locators are part of
`CitationSuffix` (no dedicated node); a segment whose suffix contains a
second `@` rejects the whole cluster (anti-email guard); `@key [p. 15]`
parses as a bare citation plus ordinary brackets.

## False-positive guards

Emails (`name@host.tld`), isolated `@`, escaped `\[@key\]`, `[not a
citation]`, and anything inside inline code or fenced code blocks are left
untouched — each locked in by tests.

## Highlighting

`citationTags` exports `@lezer/highlight` tags (parented on `labelName` /
`processingInstruction`):

```js
import { citationTags } from '@cliodeck/lezer-pandoc-citations';
```

## License

MIT © Frédéric Clavert
