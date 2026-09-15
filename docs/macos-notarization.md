# macOS — signature et notarisation

> Procédure de publication d'un build macOS signé et notarisé. Suivi : issue
> [#75](https://github.com/cliodeck/cliodeck-app/issues/75). Les questions
> encore ouvertes (Windows, Linux, CI) restent dans
> [`code-signing-decisions.md`](code-signing-decisions.md).

## Principe

electron-builder 24.13 embarque `@electron/notarize` : aucun script
`afterSign` n'est nécessaire. Le bloc `mac` de `package.json` porte
`hardenedRuntime`, les entitlements et `"notarize": true`. L'équipe est
`56789J6QWG` (public : le Team ID figure dans toute app signée). Au build :

1. **Signature** — electron-builder prend dans le trousseau l'identité
   `Developer ID Application: … (56789J6QWG)`. Sans identité, l'app sort non
   signée.
2. **Notarisation** — seulement si des identifiants sont fournis par
   l'environnement ; sinon elle est **sautée** avec un avertissement (un build
   local sans identifiants reste possible et ne casse pas).
3. **Agrafage** du ticket sur le `.app`, avant la création du DMG.

## Pourquoi `true` et pas `{ "teamId": … }` — et pas d'Apple ID

Deux pièges de la combinaison electron-builder 24.13 + `@electron/notarize`
2.2.1, mesurés le 2026-09-15 :

- **`{ "teamId": … }` casse le profil trousseau et la clé API.**
  electron-builder transmet le `teamId` *en plus* de ces identifiants, et
  `@electron/notarize` range tout `teamId` parmi les identifiants « mot de
  passe » : « Cannot use password credentials, API key credentials and keychain
  credentials at once ». Le Team ID est déjà porté par le profil ou la clé.
- **`true` + `APPLE_ID` bascule sur `altool`**, qu'Apple a fermé.

D'où la règle : `"notarize": true`, et **uniquement** un profil trousseau
(`APPLE_KEYCHAIN_PROFILE`) ou une clé API (`APPLE_API_KEY*`). Jamais
`APPLE_ID` / `APPLE_APP_SPECIFIC_PASSWORD` dans l'environnement du build.

## Identifiants

Le compte Apple connecté à la machine ne joue aucun rôle : seuls comptent le
certificat du trousseau et les identifiants passés à `notarytool`, qui peuvent
appartenir à un autre compte (celui de l'équipe développeur).

**Poste local** — un profil `notarytool` enregistré une fois dans le
trousseau avec une clé API App Store Connect (*Utilisateurs et accès →
Intégrations → Clés d'équipe*, rôle Développeur) :

```
xcrun notarytool store-credentials cliodeck-notary \
  --key /chemin/AuthKey_XXXX.p8 --key-id XXXX --issuer <issuer-uuid>
```

(Un profil créé avec `--apple-id … --team-id …` et un mot de passe d'app
fonctionne aussi : c'est un profil trousseau, le piège ci-dessus ne concerne
que les *variables* `APPLE_ID`.)

Contrôle : `xcrun notarytool history --keychain-profile cliodeck-notary`
(liste vide ou historique, sans erreur d'authentification).

**CI** — la même clé en variables `APPLE_API_KEY` (chemin du `.p8`),
`APPLE_API_KEY_ID`, `APPLE_API_ISSUER`.

## Prérequis de la machine qui signe

- **L'autorité intermédiaire « Developer ID Certification Authority » G2** dans
  le trousseau. Sans elle, le certificat est présent mais invalide :
  `security find-identity -p codesigning` le liste sous *Matching identities*
  et affiche `0 valid identities found`. Remède :
  `curl -O https://www.apple.com/certificateauthority/DeveloperIDG2CA.cer`
  puis `security import DeveloperIDG2CA.cer -k ~/Library/Keychains/login.keychain-db`.
- **La licence Xcode acceptée** si Xcode est installé
  (`sudo xcodebuild -license accept`) : sinon la recompilation des modules
  natifs échoue, et la recompilation ratée **efface** le binaire de
  `hnswlib-node` — l'app ne démarre plus jusqu'au prochain `npm run rebuild:native`.
- **Un réseau qui laisse passer `timestamp.apple.com`** : chaque fichier signé
  est horodaté, un seul échec (« The timestamp service is not available »)
  arrête le build. Relancer suffit.
- Sur macOS 15+, *Trousseau d'accès* est caché par *Mots de passe* :
  `open "/System/Library/CoreServices/Applications/Keychain Access.app"`.

## Construire

Deux familles de scripts :

| Script | Signé | Notarisé | Usage |
|---|---|---|---|
| `npm run build:mac`, `build:mac-arm`, `build:mac-intel` | oui, si le certificat est dans le trousseau | non (avertissement « skipped macOS notarization ») | build de travail |
| `npm run release:mac`, `release:mac-arm`, `release:mac-intel` | oui | oui, via le profil `cliodeck-notary` | build à publier |

Les `release:*` ne font que poser `APPLE_KEYCHAIN_PROFILE` (surchargeable :
`APPLE_KEYCHAIN_PROFILE=autre-profil npm run release:mac`). La notarisation
ajoute quelques minutes par architecture ; le journal affiche
`notarization successful`.

- La signature a lieu **à chaque build Mac** dès que le certificat est présent,
  et demande le réseau (horodatage). Pour un build de test hors ligne :
  `CSC_IDENTITY_AUTO_DISCOVERY=false npm run build:mac-arm` (app non signée).
- Le bloc `mac.target` liste `x64` **et** `arm64` : `build:mac-arm` produit
  aussi la version Intel, et `release:mac-arm` la notarise aussi.

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
