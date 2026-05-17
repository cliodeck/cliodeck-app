# Linux : activer le sandboxing Chromium

ClioDeck utilise le sandbox natif de Chromium pour isoler le processus de rendu. Sur Linux, ce mécanisme repose sur les **unprivileged user namespaces** du noyau.

## Distributions récentes (Ubuntu 24.04+, Fedora 38+, Arch)

Aucune action nécessaire : les user namespaces non-privilégiés sont activés par défaut.

## Distributions plus anciennes ou durcies

Si ClioDeck refuse de se lancer avec une erreur du type :

```
[FATAL:setuid_sandbox_host.cc] The SUID sandbox helper binary was found, but is not configured correctly.
```

ou :

```
Failed to move to new namespace: PID namespaces supported, Network namespace supported, but failed: errno = Operation not permitted
```

### Solution 1 : activer les user namespaces (recommandé)

```bash
# Vérifier l'état actuel
sysctl kernel.unprivileged_userns_clone

# Activer (temporaire, jusqu'au redémarrage)
sudo sysctl -w kernel.unprivileged_userns_clone=1

# Activer de manière permanente
echo 'kernel.unprivileged_userns_clone=1' | sudo tee /etc/sysctl.d/50-userns.conf
sudo sysctl --system
```

### Solution 2 : utiliser le SUID sandbox helper

Si votre politique de sécurité interdit les user namespaces :

```bash
# Installer le helper SUID (path peut varier selon le packaging)
sudo chown root:root /opt/cliodeck/chrome-sandbox
sudo chmod 4755 /opt/cliodeck/chrome-sandbox
```

### Solution 3 : désactiver le sandbox (non recommandé)

En dernier recours, vous pouvez lancer ClioDeck sans sandbox :

```bash
cliodeck --no-sandbox
```

Cette option réduit l'isolation de sécurité entre le contenu web et le système.

## Pourquoi ne pas livrer `--no-sandbox` par défaut ?

Le sandbox de Chromium protège contre l'exécution de code malveillant injecté via des documents (PDF, contenus web, prompts tiers). Un historien travaillant avec des sources variées bénéficie de cette couche de défense supplémentaire. La grande majorité des distributions Linux modernes supportent les user namespaces sans configuration.
