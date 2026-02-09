"""
TopicAnalyzer - Analyse de topics avec BERTopic

Utilise BERTopic pour identifier les thèmes principaux dans un corpus de documents
à partir d'embeddings pré-calculés (depuis Ollama).

Architecture :
1. UMAP pour réduction dimensionnelle (768 -> 5 dimensions)
2. HDBSCAN pour clustering
3. c-TF-IDF pour extraction de mots-clés
"""

import os
# Désactiver numba pour éviter les problèmes de compilation llvmlite
os.environ['NUMBA_DISABLE_JIT'] = '1'

from typing import List, Dict, Any, Optional
import numpy as np
from bertopic import BERTopic
from sklearn.feature_extraction.text import CountVectorizer


class TopicAnalyzer:
    """Analyseur de topics avec BERTopic optimisé pour CPU"""

    def __init__(
        self,
        min_topic_size: int = 5,
        nr_topics: int = None,
        language: str = "multilingual",
        n_gram_range: tuple = (1, 3),
    ):
        """
        Initialise le TopicAnalyzer

        Args:
            min_topic_size: Taille minimale d'un topic (défaut: 5 documents)
            nr_topics: Nombre de topics souhaités (None = automatique)
            language: Langue pour les stop words ("french", "english", "multilingual")
            n_gram_range: Plage de n-grammes pour extraction de mots-clés (défaut: 1-3)
        """
        self.min_topic_size = min_topic_size
        self.nr_topics = nr_topics if nr_topics is not None else "auto"
        self.language = language
        self.n_gram_range = n_gram_range

        # Initialiser le vectorizer pour c-TF-IDF
        # Supporte français et anglais avec stop words
        stop_words = self._get_stop_words(language)
        self.vectorizer = CountVectorizer(
            ngram_range=n_gram_range,
            stop_words=stop_words,
            min_df=1,  # Minimum document frequency
        )

        # Initialiser BERTopic avec paramètres par défaut
        # BERTopic créera automatiquement UMAP et HDBSCAN
        # IMPORTANT: Ne pas importer UMAP/HDBSCAN directement car ils nécessitent numba
        #
        # Pour obtenir plus de topics:
        # 1. Réduire min_topic_size (déjà fait - passé en paramètre)
        # 2. Utiliser nr_topics pour forcer un nombre de topics après clustering
        # 3. Si HDBSCAN trouve trop peu de clusters, ajuster min_topic_size côté TypeScript
        self.model = BERTopic(
            embedding_model=None,  # On fournira les embeddings pré-calculés
            vectorizer_model=self.vectorizer,
            min_topic_size=min_topic_size,
            nr_topics=self.nr_topics,  # Nombre de topics (auto ou fixé)
            calculate_probabilities=False,  # Plus rapide sur CPU
            verbose=True,
        )

    def _get_stop_words(self, language: str) -> Optional[List[str]]:
        """
        Retourne les stop words pour la langue spécifiée

        Args:
            language: Code langue ("french", "english", "multilingual")

        Returns:
            Liste de stop words ou None
        """
        # Stop words français
        french_stops = [
            "le",
            "la",
            "les",
            "un",
            "une",
            "des",
            "de",
            "du",
            "et",
            "ou",
            "mais",
            "donc",
            "car",
            "pour",
            "dans",
            "sur",
            "à",
            "avec",
            "par",
            "ce",
            "qui",
            "que",
            "il",
            "elle",
            "on",
            "nous",
            "vous",
            "ils",
            "elles",
            "cette",
            "ces",
            "son",
            "sa",
            "ses",
            "leur",
            "leurs",
        ]

        # Stop words anglais
        english_stops = [
            "the",
            "a",
            "an",
            "and",
            "or",
            "but",
            "in",
            "on",
            "at",
            "to",
            "for",
            "of",
            "with",
            "by",
            "from",
            "as",
            "is",
            "was",
            "are",
            "were",
            "been",
            "be",
            "have",
            "has",
            "had",
            "do",
            "does",
            "did",
            "will",
            "would",
            "could",
            "should",
            "may",
            "might",
            "can",
            "this",
            "that",
            "these",
            "those",
            "it",
            "its",
            "he",
            "she",
            "they",
            "we",
            "you",
        ]

        if language == "french":
            return french_stops
        elif language == "english":
            return english_stops
        elif language == "multilingual":
            return french_stops + english_stops
        else:
            return None

    def analyze_topics(
        self,
        embeddings: np.ndarray,
        documents: List[str],
        document_ids: List[str],
    ) -> Dict[str, Any]:
        """
        Analyse les topics à partir d'embeddings pré-calculés

        Args:
            embeddings: Array numpy (N x 768) des embeddings de documents
            documents: Liste des textes de documents (pour extraction de mots-clés)
            document_ids: Liste des IDs de documents

        Returns:
            Dictionnaire contenant :
            - topics: Liste des topics avec leurs informations
            - topic_assignments: Mapping document_id -> topic_id
            - outliers: Liste des document_ids considérés comme outliers (topic -1)
        """
        # Valider le nombre minimum de documents
        # Pour BERTopic + HDBSCAN, on a besoin d'au moins 2-3 fois min_topic_size
        min_required = max(self.min_topic_size * 2, 10)
        if len(embeddings) < min_required:
            raise ValueError(
                f"Not enough documents ({len(embeddings)}). "
                f"For reliable topic modeling with min_topic_size={self.min_topic_size}, "
                f"you need at least {min_required} documents. "
                f"Consider reducing min_topic_size or adding more documents."
            )

        print(f"Analyzing {len(embeddings)} documents...")
        print(f"Embeddings shape: {embeddings.shape}")
        print(f"Embeddings dtype: {embeddings.dtype}")
        print(f"Number of documents: {len(documents)}")

        # Vérifier qu'il n'y a pas de NaN dans les embeddings
        if np.isnan(embeddings).any():
            raise ValueError("Embeddings contain NaN values")

        # Vérifier qu'il n'y a pas d'infini dans les embeddings
        if np.isinf(embeddings).any():
            raise ValueError("Embeddings contain infinite values")

        try:
            # Fit BERTopic sur les embeddings pré-calculés
            print(f"Running BERTopic with min_topic_size={self.min_topic_size}, nr_topics={self.nr_topics}")
            topics, probs = self.model.fit_transform(documents, embeddings)

            # Vérifier que nous avons trouvé au moins un topic
            unique_topics = set(topics)
            num_topics = len(unique_topics) - (1 if -1 in unique_topics else 0)
            num_outliers_initial = list(topics).count(-1)

            print(f"HDBSCAN clustering results:")
            print(f"  - Found {num_topics} topics (excluding outliers)")
            print(f"  - {num_outliers_initial} outliers (-1)")
            print(f"  - Topic IDs: {sorted([t for t in unique_topics if t != -1])}")

            # Si nr_topics est défini et différent du nombre trouvé, BERTopic a fusionné/réduit
            if self.nr_topics != "auto" and self.nr_topics is not None:
                print(f"  - Requested {self.nr_topics} topics, HDBSCAN found {num_topics}")
                if num_topics < self.nr_topics:
                    print(f"  ⚠️  WARNING: Cannot create {self.nr_topics} topics from only {num_topics} clusters!")
                    print(f"  ℹ️  Consider reducing min_topic_size (current: {self.min_topic_size})")
                    print(f"  ℹ️  Or let HDBSCAN decide by using nr_topics='auto'")

            if num_topics == 0:
                raise ValueError(
                    "No topics found. All documents are outliers. "
                    "This usually means:\n"
                    "1. The corpus is too small\n"
                    "2. The min_topic_size is too large\n"
                    "3. The documents are too similar or too different\n"
                    f"Try reducing min_topic_size (current: {self.min_topic_size}) "
                    f"or adding more diverse documents."
                )
        except Exception as e:
            print(f"BERTopic fit_transform failed: {str(e)}")
            print(f"Error type: {type(e).__name__}")
            import traceback
            traceback.print_exc()
            raise

        # Construire la réponse
        num_outliers = topics.count(-1)
        num_documents_in_topics = len(documents) - num_outliers

        result = {
            "topics": [],
            "topic_assignments": {},
            "outliers": [],
            "statistics": {
                "total_documents": len(documents),
                "num_topics": len(set(topics)) - 1,  # -1 pour exclure le topic outlier
                "num_outliers": num_outliers,
                "num_documents_in_topics": num_documents_in_topics,
            },
        }

        print(f"📊 Documents in topics: {num_documents_in_topics}/{len(documents)} ({num_outliers} outliers)")

        # Pour chaque topic trouvé
        topic_info = self.model.get_topic_info()

        for _, row in topic_info.iterrows():
            topic_id = int(row["Topic"])

            # Skip outlier topic (-1)
            if topic_id == -1:
                continue

            # Récupérer les mots-clés du topic
            topic_words = self.model.get_topic(topic_id)

            if topic_words:
                # Extraire les top keywords (mots avec scores les plus élevés)
                # Augmenté à 20 pour plus de mots descriptifs
                keywords = [word for word, score in topic_words[:20]]

                # Générer un label automatique (5 premiers mots-clés pour plus de contexte)
                label = " - ".join(keywords[:5])

                # Trouver les documents assignés à ce topic
                doc_indices = [i for i, t in enumerate(topics) if t == topic_id]
                assigned_docs = [document_ids[i] for i in doc_indices]

                result["topics"].append(
                    {
                        "id": topic_id,
                        "label": label,
                        "keywords": keywords,
                        "documents": assigned_docs,
                        "size": len(assigned_docs),
                    }
                )

        # Mapping document_id -> topic_id
        for i, topic_id in enumerate(topics):
            doc_id = document_ids[i]

            if topic_id == -1:
                result["outliers"].append(doc_id)
            else:
                result["topic_assignments"][doc_id] = int(topic_id)

        # Trier les topics par taille (nombre de documents)
        result["topics"].sort(key=lambda x: x["size"], reverse=True)

        return result

    def get_topic_info(self, topic_id: int) -> Optional[Dict[str, Any]]:
        """
        Récupère les informations détaillées sur un topic spécifique

        Args:
            topic_id: ID du topic

        Returns:
            Dictionnaire avec informations du topic ou None si non trouvé
        """
        if not hasattr(self.model, "topics_"):
            return None

        topic_words = self.model.get_topic(topic_id)

        if not topic_words:
            return None

        keywords = [{"word": word, "score": float(score)} for word, score in topic_words]

        return {
            "id": topic_id,
            "keywords": keywords,
        }

    def reduce_topics(self, nr_topics: int) -> Dict[str, Any]:
        """
        Réduit le nombre de topics en fusionnant les plus similaires

        Args:
            nr_topics: Nombre de topics cible

        Returns:
            Résultat mis à jour après fusion
        """
        if not hasattr(self.model, "topics_"):
            raise ValueError("Model must be fitted before reducing topics")

        self.model.reduce_topics(None, nr_topics=nr_topics)

        # Note: Cette méthode nécessite de recalculer les assignments
        # Pour l'instant on retourne juste une confirmation
        return {"status": "topics_reduced", "nr_topics": nr_topics}
