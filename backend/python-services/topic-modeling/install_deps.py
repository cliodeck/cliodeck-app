#!/usr/bin/env python3
"""
Script d'installation des dépendances Python pour le topic modeling.
Installe les packages en ignorant les packages optionnels problématiques (numba, llvmlite).
"""

import subprocess
import sys

# Liste des packages à installer
# On exclut volontairement numba et llvmlite qui nécessitent LLVM
PACKAGES = [
    # FastAPI et serveur
    "fastapi>=0.109.0",
    "uvicorn>=0.27.0",

    # urllib3 compatible LibreSSL (macOS)
    "urllib3>=1.26.0,<2.0.0",

    # Pydantic pour validation
    "pydantic>=2.5.0",

    # Dépendances scientifiques de base
    # IMPORTANT: Garder numpy<2.0.0 pour compatibilité avec hdbscan, umap, etc.
    "numpy>=1.24.0,<2.0.0",
    "scipy>=1.10.0",
    "scikit-learn>=1.3.0",
    "pandas>=1.4.0",

    # HDBSCAN (wheel précompilé disponible)
    "hdbscan>=0.8.33",

    # Dépendances de BERTopic
    "plotly>=5.0.0",
    "tqdm>=4.62.0",

    # Tokenizers pour transformers
    "tokenizers",

    # joblib pour le caching
    "joblib>=1.2.0",

    # NOTE: pynndescent n'est PAS installé ici car il nécessite numba/llvmlite
    # Il sera installé automatiquement par umap-learn (avec --no-deps ci-dessous)
]

# Packages avec --no-deps (pour éviter numba)
NO_DEPS_PACKAGES = [
    "umap-learn>=0.5.6",
    "bertopic>=0.16.0",
]

# Packages optionnels (gros téléchargements, peuvent timeout)
# On les installe séparément avec plus de retries
OPTIONAL_LARGE_PACKAGES = [
    "sentence-transformers>=2.2.0",
]

# Packages optionnels à ignorer complètement s'ils échouent
OPTIONAL_PACKAGES = [
    "numba",
    "llvmlite",
    "sentence-transformers",  # Optionnel car on fournit déjà les embeddings
    # pynndescent n'est plus optionnel, il est maintenant requis par UMAP
]

def install_package(package, no_deps=False, retries=2, timeout=600):
    """Install un package avec pip avec retry et timeout."""
    for attempt in range(retries):
        try:
            cmd = [sys.executable, "-m", "pip", "install", "--no-cache-dir", "--timeout=600"]
            if no_deps:
                cmd.append("--no-deps")
            cmd.append(package)

            if attempt > 0:
                print(f"📦 Retry {attempt + 1}/{retries}: Installing {package}...")
            else:
                print(f"📦 Installing {package}{'(no-deps)' if no_deps else ''}...")

            result = subprocess.run(
                cmd,
                capture_output=True,
                text=True,
                check=True,
                timeout=timeout
            )
            # Afficher la sortie si verbose
            if result.stdout and "Successfully installed" in result.stdout:
                # Afficher uniquement la ligne de succès
                for line in result.stdout.split('\n'):
                    if "Successfully installed" in line:
                        print(f"   {line.strip()}")
            print(f"✅ {package} installed successfully")
            return True
        except subprocess.TimeoutExpired:
            print(f"⏱️  Timeout installing {package} (attempt {attempt + 1}/{retries})")
            if attempt < retries - 1:
                print("   Retrying...")
                continue
            else:
                print(f"❌ Failed to install {package} after {retries} attempts (timeout)")
                return False
        except subprocess.CalledProcessError as e:
            print(f"❌ Failed to install {package} (attempt {attempt + 1}/{retries})")
            if e.stderr:
                # Afficher seulement les dernières lignes de l'erreur
                error_lines = e.stderr.strip().split('\n')
                for line in error_lines[-10:]:  # Dernières 10 lignes
                    print(f"  {line}")
            if attempt < retries - 1:
                print("   Retrying...")
                continue
            else:
                return False
    return False

def main():
    """Install all packages."""
    print("🔧 Starting installation of Python dependencies...")
    print("=" * 60)

    failed = []

    # Installer les packages normaux
    print("\n📦 Installing standard packages...")
    for package in PACKAGES:
        if not install_package(package):
            # Vérifier si c'est un package optionnel
            pkg_name = package.split(">=")[0].split("==")[0].split("<")[0]
            if pkg_name not in OPTIONAL_PACKAGES:
                failed.append(package)

    # Installer les packages sans dépendances (évite numba)
    print("\n📦 Installing packages without dependencies (to skip numba)...")
    for package in NO_DEPS_PACKAGES:
        if not install_package(package, no_deps=True):
            pkg_name = package.split(">=")[0].split("==")[0].split("<")[0]
            if pkg_name not in OPTIONAL_PACKAGES:
                failed.append(package)

    # Installer les packages optionnels (gros téléchargements) avec plus de retries
    print("\n📦 Installing optional large packages (with extended timeout)...")
    optional_failed = []
    for package in OPTIONAL_LARGE_PACKAGES:
        # 3 retries avec timeout de 10 minutes pour les gros packages
        if not install_package(package, retries=3, timeout=600):
            optional_failed.append(package)

    print("=" * 60)

    if failed:
        print(f"❌ {len(failed)} CRITICAL package(s) failed to install:")
        for pkg in failed:
            print(f"   - {pkg}")
        sys.exit(1)
    elif optional_failed:
        print(f"⚠️  {len(optional_failed)} optional package(s) failed to install:")
        for pkg in optional_failed:
            print(f"   - {pkg}")
        print("\n✅ Core packages installed successfully!")
        print("⚠️  Optional packages failed but are not required for basic functionality.")
        print("   You can install them manually later with:")
        for pkg in optional_failed:
            print(f"   pip install {pkg}")
        print("\nNote: numba and llvmlite were intentionally skipped.")
        print("BERTopic will work without them, just slightly slower.")
        sys.exit(0)  # Exit avec succès même si optionnels ont échoué
    else:
        print("✅ All packages installed successfully!")
        print("\nNote: numba and llvmlite were intentionally skipped.")
        print("BERTopic will work without them, just slightly slower.")
        sys.exit(0)

if __name__ == "__main__":
    main()
