---
title: "Danzig 1932 — présentation de test"
author: Frédéric Clavert
theme: night
transition: fade
---

# Danzig, 1932

Un deck réaliste pour le corpus de fidélité : frontmatter YAML,
sections H1, verticale H2, note de présentateur, séparateur piégé.

---

## Le Volkstag

- Élections de 1932 [@lester1932]
- Contexte européen [@clavert2013, p. 12]

Note: rappeler ici le contexte de la Société des Nations.

---

## Un bloc de code piégé

```js
const separateur = 'non';
---
// la ligne ci-dessus n'est PAS un séparateur de slide
```

Texte après le bloc, toujours dans la même slide.

---

# Section suivante

Slide d'ouverture de section.

---

## Verticale de la section

Une note[^s1] pour faire bonne mesure.

Notes: variante « Notes: » acceptée par l'export reveal.

[^s1]: Note de bas de page dans un deck.
