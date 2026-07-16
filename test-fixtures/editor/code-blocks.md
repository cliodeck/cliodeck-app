# Blocs de code

Bloc avec langue :

```python
def compter_mots(texte: str) -> int:
    # commentaire avec accents : déjà vu, œuvre
    return len(texte.split())
```

Bloc TypeScript :

```typescript
const notes: string[] = ["[^1]", "[@faux]"]; // syntaxe md dans du code : ne pas décorer
```

Bloc sans langue :

```
Texte brut avec des *astérisques* et [@une-fausse-citation] qui ne doivent
pas être interprétés.
```

Bloc clôturé par tildes :

~~~yaml
cle: valeur
liste:
  - a
  - b
~~~

Code indenté de quatre espaces :

    ligne de code indentée
    seconde ligne

Et du `code inline avec [@clef] dedans` qui ne doit pas être décoré.
