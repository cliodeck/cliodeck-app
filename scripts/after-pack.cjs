/**
 * after-pack.js
 *
 * Ce script s'exécute après chaque empaquetage d'architecture par electron-builder.
 * Il reconstruit les dépendances natives avec electron-rebuild pour s'assurer
 * que les binaires correspondent à l'architecture cible.
 *
 * Cela résout le problème où electron-builder peut laisser des binaires
 * de la mauvaise architecture dans node_modules après le build.
 */

const { execSync } = require('child_process');
const path = require('path');
const os = require('os');

module.exports = async function (context) {
  const { electronPlatformName, arch, appOutDir } = context;

  console.log(`\n🔧 after-pack: Rebuilding native modules for ${electronPlatformName} ${arch}`);

  // Mapper les valeurs d'arch qui peuvent être des enums ou des strings
  const archMap = {
    0: 'ia32',
    1: 'x64',
    2: 'armv7l',
    3: 'arm64',
    4: 'universal'
  };

  // Déterminer l'architecture cible du build
  let targetArch = typeof arch === 'number' ? archMap[arch] : arch;

  console.log(`📋 Build target arch: ${targetArch} (raw value: ${arch})`);

  // Pour les builds universal, on ne reconstruit pas (electron-builder gère)
  if (targetArch === 'universal') {
    console.log('⏭️  Skipping rebuild for universal build (handled by electron-builder)');
    return;
  }

  // Reconstruire les modules natifs pour l'architecture de la machine locale
  // Cela assure que npm start fonctionnera après le build multi-architecture
  try {
    const projectRoot = path.resolve(__dirname, '..');
    const currentArch = os.arch(); // Architecture de la machine actuelle

    console.log(`📋 Current machine arch: ${currentArch}`);
    console.log(`📋 Project root: ${projectRoot}`);

    // Toujours reconstruire pour l'architecture locale après chaque empaquetage
    // car electron-builder modifie node_modules pour chaque architecture cible
    console.log(`🔄 Rebuilding native modules for machine arch (${currentArch})...`);

    // Utiliser electron-rebuild pour reconstruire pour l'architecture locale
    const rebuildCmd = `npx electron-rebuild -f -a ${currentArch}`;
    console.log(`Running: ${rebuildCmd}`);
    execSync(rebuildCmd, {
      cwd: projectRoot,
      stdio: 'inherit'
    });

    console.log(`✅ Native modules rebuilt for ${currentArch}`);
  } catch (error) {
    console.error('❌ Error rebuilding native modules:', error.message);
    // Ne pas faire échouer le build si le rebuild échoue
    console.warn('⚠️  Continuing despite rebuild error...');
  }

  console.log('✅ after-pack completed\n');
};
