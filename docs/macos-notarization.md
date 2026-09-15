# macOS — signature et notarisation

> Procédure de publication d'un build macOS signé et notarisé. Suivi : issue
> [#75](https://github.com/cliodeck/cliodeck-app/issues/75). Les questions
> encore ouvertes (Windows, Linux, CI) restent dans
> [`code-signing-decisions.md`](code-signing-decisions.md).

## Principe

electron-builder 24.13 embarque `@electron/notarize` : aucun script
`afterSign` n'est nécessaire. Le bloc `mac` de `package.json` porte
`hardenedRuntime`, les entitlements et `notarize.teamId` (`56789J6QWG`, public :
il figure dans toute app signée). Au build :

1. **Signature** — electron-builder prend dans le trousseau l'identité
   `Developer ID Application: … (56789J6QWG)`. Sans identité, l'app sort non
   signée.
2. **Notarisation** — seulement si des identifiants sont fournis par
   l'environnement ; sinon elle est **sautée en silence** (un build local sans
   identifiants reste possible et ne casse pas).
3. **Agrafage** du ticket sur le `.app`, avant la création du DMG.

## Ne jamais écrire `"notarize": true`

Avec `APPLE_ID` en environnement, la v24 lit `true` comme l'ancien mode et
appelle `altool`, qu'Apple a fermé. Garder l'objet `{ "teamId": … }`, qui force
`notarytool`.

## Identifiants

Le compte Apple connecté à la machine ne joue aucun rôle : seuls comptent le
certificat du trousseau et les identifiants passés à `notarytool`, qui peuvent
appartenir à un autre compte (celui de l'équipe développeur).

**Poste local (recommandé)** — un profil `notarytool` enregistré une fois dans
le trousseau, soit avec une clé API App Store Connect :

```
xcrun notarytool store-credentials cliodeck-notary \
  --key /chemin/AuthKey_XXXX.p8 --key-id XXXX --issuer <issuer-uuid>
```

soit avec l'Apple ID du compte développeur et un mot de passe d'app (demandé
par la commande, jamais tapé en argument) :

```
xcrun notarytool store-credentials cliodeck-notary \
  --apple-id <compte-developpeur> --team-id 56789J6QWG
```

Contrôle : `xcrun notarytool history --keychain-profile cliodeck-notary`
(liste vide ou historique, sans erreur d'authentification).

**Variables reconnues par electron-builder**, par ordre de priorité :
`APPLE_ID` + `APPLE_APP_SPECIFIC_PASSWORD` ; `APPLE_API_KEY` +
`APPLE_API_KEY_ID` + `APPLE_API_ISSUER` ; `APPLE_KEYCHAIN_PROFILE` (option
`APPLE_KEYCHAIN`). La première famille présente l'emporte : ne pas en laisser
traîner une autre dans l'environnement.

## Construire

```
APPLE_KEYCHAIN_PROFILE=cliodeck-notary npm run build:mac-arm
```

(`build:mac-intel` et `build:mac-universal` de même.) La notarisation ajoute
quelques minutes ; le journal affiche `notarization successful`.

## Vérifier l'artefact

```
codesign --verify --deep --strict --verbose=2 release/mac-arm64/ClioDeck.app
spctl -a -vvv -t exec release/mac-arm64/ClioDeck.app   # attendu : accepted, source=Notarized Developer ID
xcrun stapler validate release/mac-arm64/ClioDeck.app
```

Puis ouvrir le `.dmg` sur un Mac qui ne l'a jamais vu (ou après
`xattr -w com.apple.quarantine …`) : aucune alerte Gatekeeper attendue.

## En cas de refus

`notarytool` renvoie un identifiant de soumission. Le journal nomme chaque
fichier refusé :

```
xcrun notarytool log <submission-id> --keychain-profile cliodeck-notary
```

Cause la plus probable : un binaire natif embarqué (`better-sqlite3`,
`hnswlib-node`, `node-llama-cpp`, `canvas`) non signé ou sans runtime renforcé.

## Sauvegardes à garder hors du dépôt

- Le certificat **avec sa clé privée**, exporté en `.p12` depuis le Trousseau :
  la clé n'existe que sur le Mac où la demande a été faite.
- Le fichier `AuthKey_XXXX.p8`, s'il est utilisé : Apple ne le laisse
  télécharger qu'une fois.

Ce sont aussi les deux pièces qu'il faudra en secrets GitHub pour notariser en
CI (`CSC_LINK` / `CSC_KEY_PASSWORD`, `APPLE_API_KEY*`) — non câblé à ce jour.
