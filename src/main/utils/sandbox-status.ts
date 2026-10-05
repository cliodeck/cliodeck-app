/**
 * Le bac à sable de Chromium est-il coupé ?
 *
 * Depuis electron-builder 26, le lanceur de l'AppImage ajoute de lui-même
 * `--no-sandbox` quand les espaces de noms utilisateur non privilégiés sont
 * indisponibles (réglage par défaut d'Ubuntu 24.04). L'app démarre alors
 * sans bac à sable, là où elle refusait de démarrer auparavant — et rien ne
 * le disait (#151). On l'accepte, à condition que l'utilisateur le sache.
 *
 * Seul Linux est concerné : ailleurs, personne n'ajoute cette option à
 * l'insu de l'utilisateur (les tests e2e la passent sur toutes les
 * plateformes, sans que cela doive déclencher d'avertissement).
 */

export interface SandboxStatus {
  /** L'application tourne sans le bac à sable de Chromium. */
  disabled: boolean;
  /** …et elle a été lancée depuis une AppImage : le remède est le paquet `.deb`. */
  appImage: boolean;
}

export function sandboxStatus(input: {
  platform: NodeJS.Platform;
  /** `app.commandLine.hasSwitch('no-sandbox')` — vrai aussi avec `ELECTRON_DISABLE_SANDBOX`. */
  noSandboxSwitch: boolean;
  /** `process.env.APPIMAGE`, que le runtime AppImage définit au lancement. */
  appImagePath: string | undefined;
}): SandboxStatus {
  const disabled = input.platform === 'linux' && input.noSandboxSwitch;
  return { disabled, appImage: disabled && Boolean(input.appImagePath) };
}
