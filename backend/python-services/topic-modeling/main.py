"""
Service Python pour Topic Modeling avec BERTopic

API REST avec FastAPI pour analyser les topics d'un corpus de documents.
Reçoit des embeddings pré-calculés depuis Electron/Ollama.

Endpoints:
- GET /health : Health check
- POST /analyze : Analyse de topics à partir d'embeddings
"""

from typing import List, Dict, Any, Optional
from fastapi import FastAPI, HTTPException, status
from fastapi.middleware.cors import CORSMiddleware
from pydantic import BaseModel, Field, field_validator, model_validator
import numpy as np
import uvicorn

from topic_analyzer import TopicAnalyzer


# MARK: - Pydantic Models

class AnalyzeRequest(BaseModel):
    """Requête pour l'analyse de topics"""

    embeddings: List[List[float]] = Field(
        ...,
        description="Liste des embeddings (N x 768)",
        min_length=5
    )
    documents: List[str] = Field(
        ...,
        description="Liste des textes de documents",
        min_length=5
    )
    document_ids: List[str] = Field(
        ...,
        description="Liste des IDs de documents",
        min_length=5
    )
    min_topic_size: Optional[int] = Field(
        5,
        description="Taille minimale d'un topic",
        ge=2,
        le=50
    )
    nr_topics: Optional[int] = Field(
        None,
        description="Nombre de topics souhaités (None = automatique)",
        ge=2,
        le=100
    )
    language: Optional[str] = Field(
        "multilingual",
        description="Langue pour stop words (french, english, multilingual)"
    )
    n_gram_range: Optional[tuple] = Field(
        (1, 3),
        description="Plage de n-grammes pour mots-clés"
    )

    @field_validator('embeddings')
    @classmethod
    def validate_embeddings(cls, v):
        """Valide que tous les embeddings ont la même dimension"""
        if not v:
            raise ValueError("embeddings cannot be empty")

        first_len = len(v[0])
        if not all(len(emb) == first_len for emb in v):
            raise ValueError("All embeddings must have the same dimension")

        return v

    @field_validator('language')
    @classmethod
    def validate_language(cls, v):
        """Valide que la langue est supportée"""
        allowed = ["french", "english", "multilingual"]
        if v not in allowed:
            raise ValueError(f"Language must be one of {allowed}")
        return v

    @model_validator(mode='after')
    def validate_same_length(self):
        """Valide que documents et document_ids ont la même longueur que embeddings"""
        if len(self.documents) != len(self.embeddings):
            raise ValueError(
                f"Length mismatch: {len(self.documents)} documents but {len(self.embeddings)} embeddings"
            )
        if len(self.document_ids) != len(self.embeddings):
            raise ValueError(
                f"Length mismatch: {len(self.document_ids)} document_ids but {len(self.embeddings)} embeddings"
            )
        return self


class Topic(BaseModel):
    """Représentation d'un topic"""
    id: int
    label: str
    keywords: List[str]
    documents: List[str]
    size: int


class AnalyzeResponse(BaseModel):
    """Réponse de l'analyse de topics"""
    topics: List[Topic]
    topic_assignments: Dict[str, int]
    outliers: List[str]
    statistics: Dict[str, Any]


class HealthResponse(BaseModel):
    """Réponse du health check"""
    status: str
    service: str
    version: str


# MARK: - FastAPI App

app = FastAPI(
    title="ClioDesk Topic Modeling Service",
    description="Service Python pour analyse de topics avec BERTopic",
    version="1.0.0",
)

# CORS pour permettre les requêtes depuis Electron
app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],  # En production, restreindre aux origines autorisées
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)


# MARK: - Endpoints

@app.get("/health", response_model=HealthResponse)
async def health_check():
    """
    Health check endpoint

    Vérifie que le service est opérationnel.
    """
    return HealthResponse(
        status="healthy",
        service="topic-modeling",
        version="1.0.0"
    )


@app.post("/analyze", response_model=AnalyzeResponse)
async def analyze_topics(request: AnalyzeRequest):
    """
    Analyse les topics d'un corpus de documents

    Args:
        request: Requête contenant embeddings, textes et métadonnées

    Returns:
        Résultat de l'analyse avec topics, assignments et statistiques

    Raises:
        HTTPException: Si l'analyse échoue
    """
    try:
        # Convertir embeddings en numpy array
        embeddings_array = np.array(request.embeddings, dtype=np.float32)

        print(f"Received {len(request.embeddings)} embeddings")
        print(f"Embedding dimension: {embeddings_array.shape[1]}")
        print(f"Language: {request.language}")
        print(f"Min topic size: {request.min_topic_size}")

        # Créer l'analyseur
        analyzer = TopicAnalyzer(
            min_topic_size=request.min_topic_size,
            nr_topics=request.nr_topics,
            language=request.language,
            n_gram_range=request.n_gram_range,
        )

        # Analyser les topics
        result = analyzer.analyze_topics(
            embeddings=embeddings_array,
            documents=request.documents,
            document_ids=request.document_ids,
        )

        print(f"Analysis complete: {result['statistics']['num_topics']} topics found")

        # Convertir en response model
        topics = [Topic(**topic) for topic in result["topics"]]

        return AnalyzeResponse(
            topics=topics,
            topic_assignments=result["topic_assignments"],
            outliers=result["outliers"],
            statistics=result["statistics"],
        )

    except ValueError as e:
        print(f"ValueError during topic analysis: {str(e)}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_400_BAD_REQUEST,
            detail=f"Invalid request: {str(e)}"
        )
    except Exception as e:
        print(f"Error during topic analysis: {str(e)}")
        print(f"Error type: {type(e).__name__}")
        import traceback
        traceback.print_exc()
        raise HTTPException(
            status_code=status.HTTP_500_INTERNAL_SERVER_ERROR,
            detail=f"Topic analysis failed: {type(e).__name__}: {str(e)}"
        )


# MARK: - Main

if __name__ == "__main__":
    # Lancer le serveur sur le port 8001
    uvicorn.run(
        "main:app",
        host="127.0.0.1",
        port=8001,
        reload=False,  # Désactiver auto-reload en production
        log_level="info",
    )
