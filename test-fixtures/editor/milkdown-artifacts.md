# Artefacts hérités de Milkdown

Ce document reproduit ce que l'éditeur actuel a réellement écrit dans des
documents utilisateurs : échappements parasites et marqueurs de provenance.
Le nouvel éditeur doit les préserver tels quels (le hack `unescapeCitations`
de l'export les répare aujourd'hui ; il disparaît en Phase 5).

Une citation échappée \[@lester1932\] au fil du texte, et une autre forme
\[@clavert2013, p. 12\] avec locator.

Crochets échappés sans citation : \[note interne\], astérisque littéral \*,
underscore littéral \_, dièse en début de ligne :

\# pas un titre

<!-- cliodeck-gen mode="brainstorm" model="qwen3:14b" date="2026-05-12T14:03:21.000Z" -->
Un paragraphe inséré par l'IA et balisé par l'ancien mécanisme de provenance,
que l'annotation changeOrigin rendra redondant (Phase 4) mais qui existe dans
les documents réels.
<!-- /cliodeck-gen -->

Texte final après le bloc balisé.
