# ClioDesk - Topic Modeling Service

Service Python pour l'analyse de topics avec BERTopic. Ce service reçoit des embeddings pré-calculés depuis Electron/Ollama et retourne les topics identifiés.

## Architecture

```
┌─────────────────┐
│  Electron App   │
│  (TypeScript)   │
└────────┬────────┘
         │ HTTP
         ▼
┌─────────────────┐      ┌──────────────┐
│   FastAPI       │─────▶│  BERTopic    │
│  (Python 3.11)  │      │  Analyzer    │
└─────────────────┘      └──────────────┘
```

## Installation

### Prérequis

- Python 3.11+
- pip

### Installation des dépendances

```bash
cd backend/python-services/topic-modeling
pip install -r requirements.txt
```

## Utilisation

### Démarrer le service

```bash
python main.py
```

Le service démarre sur `http://127.0.0.1:8001`

### Endpoints

#### `GET /health`

Health check du service.

**Réponse :**
```json
{
  "status": "healthy",
  "service": "topic-modeling",
  "version": "1.0.0"
}
```

#### `POST /analyze`

Analyse les topics d'un corpus de documents.

**Requête :**
```json
{
  "embeddings": [[0.1, 0.2, ...], ...],  // N x 768
  "documents": ["texte du doc 1", ...],
  "document_ids": ["doc1", "doc2", ...],
  "min_topic_size": 5,                   // Optionnel (défaut: 5)
  "language": "multilingual",            // Optionnel (french, english, multilingual)
  "n_gram_range": [1, 3]                 // Optionnel (défaut: [1, 3])
}
```

**Réponse :**
```json
{
  "topics": [
    {
      "id": 0,
      "label": "constructivisme - apprentissage - Papert",
      "keywords": ["constructivisme", "apprentissage", "Papert", ...],
      "documents": ["doc1", "doc3", ...],
      "size": 12
    },
    ...
  ],
  "topic_assignments": {
    "doc1": 0,
    "doc2": 1,
    ...
  },
  "outliers": ["doc5", "doc7"],
  "statistics": {
    "total_documents": 50,
    "num_topics": 5,
    "num_outliers": 2
  }
}
```

## Fonctionnement

### BERTopic Pipeline

1. **Embeddings pré-calculés** : Le service reçoit des embeddings générés par Ollama (nomic-embed-text, 768 dimensions)

2. **UMAP** : Réduction dimensionnelle (768 → 5 dimensions)

3. **HDBSCAN** : Clustering des documents dans l'espace réduit

4. **c-TF-IDF** : Extraction de mots-clés caractéristiques pour chaque cluster

### Paramètres

- **min_topic_size** : Nombre minimum de documents pour former un topic (défaut: 5)
  - Valeur faible → Plus de topics, plus spécifiques
  - Valeur élevée → Moins de topics, plus généraux

- **language** : Langue pour les stop words
  - `"french"` : Stop words français uniquement
  - `"english"` : Stop words anglais uniquement
  - `"multilingual"` : Les deux (recommandé pour corpus mixtes)

- **n_gram_range** : Taille des n-grammes pour les mots-clés
  - `(1, 1)` : Mots uniques seulement
  - `(1, 2)` : Mots uniques + bigrammes
  - `(1, 3)` : Mots uniques + bigrammes + trigrammes (défaut)

## Performance

### Temps d'exécution estimé

- 10 documents : ~5-10s
- 50 documents : ~10-20s
- 100 documents : ~20-40s

*Sur CPU Core i5, sans GPU*

### Optimisations

- `calculate_probabilities=False` : Désactivé pour performances CPU
- `nr_topics="auto"` : Détection automatique du nombre optimal de topics
- Embeddings pré-calculés : Pas besoin de modèle de sentence encoding

## Développement

### Structure du code

```
topic-modeling/
├── main.py              # API FastAPI (endpoints)
├── topic_analyzer.py    # Logique BERTopic
├── requirements.txt     # Dépendances Python
└── README.md           # Documentation
```

### Tests

Tester le health check :
```bash
curl http://127.0.0.1:8001/health
```

Tester l'analyse (avec des données simulées) :
```bash
curl -X POST http://127.0.0.1:8001/analyze \
  -H "Content-Type: application/json" \
  -d @test_data.json
```

## Intégration avec Electron

Le service est conçu pour être lancé comme subprocess depuis Electron via `TopicModelingService.ts` (Phase 2.2).

**Workflow :**
1. Electron démarre le service Python via `child_process.spawn()`
2. Health check pour vérifier que le service est prêt
3. Electron envoie des requêtes HTTP POST avec les embeddings
4. Le service retourne les topics
5. Electron arrête le service à la fermeture de l'app

## Dépendances

- **bertopic** : Algorithme de topic modeling
- **fastapi** : Framework API REST
- **uvicorn** : Serveur ASGI
- **numpy** : Manipulation d'arrays
- **scikit-learn** : Algorithmes ML (UMAP, HDBSCAN via BERTopic)
- **pydantic** : Validation de données

## Licence

Voir le fichier LICENSE du projet ClioDesk.
