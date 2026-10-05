/**
 * Signature macOS : rendre à `codesign` l'empreinte du certificat.
 *
 * electron-builder 26 prépare les options de signature avec l'empreinte SHA-1
 * du certificat (`buildSignOptions`), puis la remplace par son NOM au moment
 * de signer (`doSign`). Or `codesign` ne retrouve pas une identité par un nom
 * accentué :
 *
 *   Developer ID Application: Frédéric Clavert (56789J6QWG): no identity found
 *
 * alors que le certificat est bien dans le trousseau (mesuré : par le nom,
 * échec ; par l'empreinte ou par un fragment sans accent, succès). La 24
 * passait l'empreinte, et les builds signés fonctionnaient.
 *
 * Un crochet `mac.sign` reçoit les options AVANT ce remplacement. Il suffit
 * donc de signer avec elles, par la fonction même qu'electron-builder aurait
 * appelée — mêmes reprises quand le serveur d'horodatage d'Apple flanche.
 *
 * À retirer quand une version publiée d'electron-builder contiendra le
 * correctif amont (electron-userland/electron-builder@56d2d746, 2026-09-27 ;
 * absent de la 26.17.0).
 */
const { sign } = require('app-builder-lib/out/codeSign/macCodeSign');

module.exports = function macSign(options) {
  return sign(options);
};
