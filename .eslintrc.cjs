/**
 * Config ESLint (#36) — première configuration du dépôt.
 *
 * Philosophie : le lint doit passer sur le code ACTUEL (erreurs = 0) pour
 * être exécutable en CI dès aujourd'hui ; les règles bruyantes sur
 * l'existant sont en `warn` et seront durcies règle par règle (le compte
 * de warnings sert de plafond à ne pas dépasser). Voir #57 pour les
 * chantiers d'hygiène associés.
 */
module.exports = {
  root: true,
  parser: '@typescript-eslint/parser',
  plugins: ['@typescript-eslint', 'react-hooks'],
  extends: ['eslint:recommended', 'plugin:@typescript-eslint/recommended'],
  env: { node: true, browser: true, es2022: true },
  parserOptions: {
    ecmaVersion: 2022,
    sourceType: 'module',
    ecmaFeatures: { jsx: true },
  },
  ignorePatterns: [
    'dist/',
    'node_modules/',
    'coverage/',
    '*.cjs',
    '*.mjs',
    'test-fixtures/',
  ],
  rules: {
    // L'app journalise volontairement en console (préfixes emoji) — le
    // routage production est traité par #57.
    'no-console': 'off',
    // ~30 `any` assumés restent (reliquat d'audit #57) : warn, pas error.
    '@typescript-eslint/no-explicit-any': 'warn',
    '@typescript-eslint/no-unused-vars': [
      'warn',
      { argsIgnorePattern: '^_', varsIgnorePattern: '^_' },
    ],
    // Hooks React : le code portait déjà des disables ciblés pour ce
    // plugin, absent jusqu'ici. `warn` le temps de résorber l'existant.
    'react-hooks/rules-of-hooks': 'error',
    'react-hooks/exhaustive-deps': 'warn',
    // Motifs présents et pour l'essentiel intentionnels (regex de
    // sanitisation, espaces insécables français, @ts-ignore hérités) :
    // warn — à durcir règle par règle.
    'no-useless-escape': 'warn',
    'no-control-regex': 'warn',
    'no-irregular-whitespace': ['warn', { skipStrings: true, skipTemplates: true }],
    'no-constant-condition': ['warn', { checkLoops: false }],
    '@typescript-eslint/ban-ts-comment': [
      'warn',
      { 'ts-expect-error': 'allow-with-description' },
    ],
    '@typescript-eslint/no-var-requires': 'warn',
  },
};
