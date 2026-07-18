# @cliodeck/lezer-footnotes

Footnote extension for the [Lezer Markdown parser](https://github.com/lezer-parser/markdown):
inline references (`[^1]`, `[^free-form-id]`) and block definitions
(`[^1]: content`, with indented continuation and multiple paragraphs).
Works with CodeMirror 6 via `@codemirror/lang-markdown` and with any
`@lezer/markdown` consumer.

Extracted from [ClioDeck](https://github.com/cliodeck/cliodeck-app), a
desktop writing environment for historians, where it powers live-rendered
footnotes with byte-perfect document fidelity. Battle-tested against a
fixture corpus (nested references, non-ASCII identifiers, footnotes inside
blockquotes and tables, code-block false positives).

## Install

```
npm install @cliodeck/lezer-footnotes
```

Peer dependencies: `@lezer/markdown` ≥ 1, `@lezer/highlight` ≥ 1.

## Usage

With CodeMirror 6:

```js
import { markdown, markdownLanguage } from '@codemirror/lang-markdown';
import { Footnotes } from '@cliodeck/lezer-footnotes';

markdown({ base: markdownLanguage, extensions: [Footnotes] });
```

With the bare parser:

```js
import { parser } from '@lezer/markdown';
import { Footnotes } from '@cliodeck/lezer-footnotes';

const p = parser.configure([Footnotes]);
```

## Syntax tree

```
Note[^1] in a paragraph.        [^1]: The definition.

FootnoteReference 4-8           FootnoteDefinition (block)
├─ FootnoteMark "[^"            ├─ FootnoteMark "[^"
├─ FootnoteLabel "1"            ├─ FootnoteLabel "1"
└─ FootnoteMark "]"             ├─ FootnoteMark "]:"
                                └─ …child blocks (paragraphs)
```

- Identifiers may be numeric (`[^1]`) or free-form (`[^lester-danzig]`),
  including non-ASCII (`[^ü]`). No whitespace or `]` inside.
- Definitions support lazy continuation and indented follow-up paragraphs
  (same model as `ListItem`).
- References inside inline code or fenced code blocks are not parsed.

## Highlighting

`footnoteTags` exports `@lezer/highlight` tags (parented on `labelName` /
`processingInstruction`) so default highlight styles pick footnotes up
without configuration:

```js
import { footnoteTags } from '@cliodeck/lezer-footnotes';
```

## License

MIT © Frédéric Clavert
