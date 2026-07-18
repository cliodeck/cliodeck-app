---
title: "Document composite"
author: [Frédéric Clavert]
lang: fr
---

# Document composite

Un paragraphe qui combine un appel de note[^1], une citation [@lester1932,
p. 12] coupée par un retour à la ligne, un cluster [@lester1932;
@clavert2013], du **gras _imbriqué dans de l'italique_**, du `code inline`
et un [lien](https://www.example.org).

## Table contenant citations et notes

| Clé                | Note   | Formule           |
|:-------------------|:-------|:------------------|
| [@schmidt1988]     | [^2]   | *emphase* en cellule |

## Bloc de code au milieu

```markdown
# Ce titre est du code, pas un titre
[^99]: ni une vraie note
```

> Citation en bloc avec [@clavert2013] et une note[^3], sur
> deux lignes préfixées.

- [ ] Tâche contenant [@lester1932] et une note[^4]

![Image](images/exemple.png)

---

[^1]: Note du paragraphe d'ouverture.
[^2]: Note appelée depuis la table.
[^3]: Note appelée depuis la citation en bloc.
[^4]: Note appelée depuis une tâche.
