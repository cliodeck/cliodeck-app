/**
 * Le service Python de thèmes n'est ouvert à aucune page web (S13-2-12).
 *
 * Avant : CORSMiddleware acceptait toute origine (`allow_origins=["*"]`,
 * avec credentials) et aucune requête n'était authentifiée. Une page
 * visitée pouvait poster sur /analyze : le calcul synchrone bloquait la
 * boucle d'uvicorn, et les analyses de l'historien attendaient derrière.
 *
 * Le premier test lit le source et tourne partout (CI comprise). Le second
 * joue l'application FastAPI elle-même, avec un `topic_analyzer` simulé qui
 * compte ses appels ; il a besoin du venv du service et se saute sans lui.
 * L'appel ASGI est fait à la main (asyncio) plutôt que par TestClient, qui
 * exige httpx, absent des dépendances du service.
 */
import { describe, it, expect } from 'vitest';
import { spawnSync } from 'child_process';
import fs from 'fs';
import os from 'os';
import path from 'path';

const serviceDir = path.resolve(__dirname, '../../../python-services/topic-modeling');
const mainPy = path.join(serviceDir, 'main.py');
const venvPython = path.join(os.homedir(), '.cliodeck', 'python-venv', 'bin', 'python3');
const hasVenv = fs.existsSync(venvPython);

describe('main.py — source', () => {
  it('ne contient plus CORSMiddleware', () => {
    const source = fs.readFileSync(mainPy, 'utf-8');
    expect(source.includes('CORSMiddleware')).toBe(false);
  });
});

// Driver Python : importe main.py avec un TopicAnalyzer simulé, puis appelle
// l'application ASGI directement et imprime une ligne JSON par requête.
const DRIVER = String.raw`
import asyncio, json, sys, types

calls = []

class FakeAnalyzer:
    def __init__(self, **kwargs):
        pass
    def analyze_topics(self, embeddings, documents, document_ids):
        calls.append(len(documents))
        return {
            "topics": [],
            "topic_assignments": {},
            "outliers": [],
            "statistics": {"total_documents": len(documents), "num_topics": 0,
                           "num_outliers": 0, "num_documents_in_topics": 0},
        }

fake = types.ModuleType("topic_analyzer")
fake.TopicAnalyzer = FakeAnalyzer
sys.modules["topic_analyzer"] = fake
sys.path.insert(0, sys.argv[1])
import main

BODY = json.dumps({
    "embeddings": [[0.1, 0.2]] * 5,
    "documents": ["a", "b", "c", "d", "e"],
    "document_ids": ["1", "2", "3", "4", "5"],
}).encode()

async def call(method, path, headers, body=b""):
    scope = {
        "type": "http", "asgi": {"version": "3.0"}, "http_version": "1.1",
        "method": method, "scheme": "http", "path": path, "raw_path": path.encode(),
        "query_string": b"", "root_path": "",
        "headers": [(k.lower().encode(), v.encode()) for k, v in headers.items()],
        "client": ("127.0.0.1", 50000), "server": ("127.0.0.1", 8001),
    }
    sent = {"done": False}
    async def receive():
        if not sent["done"]:
            sent["done"] = True
            return {"type": "http.request", "body": body, "more_body": False}
        await asyncio.sleep(3600)
    out = {"status": None, "headers": {}}
    async def send(message):
        if message["type"] == "http.response.start":
            out["status"] = message["status"]
            out["headers"] = {k.decode().lower(): v.decode() for k, v in message.get("headers", [])}
    await main.app(scope, receive, send)
    return out

async def run():
    results = {}
    results["preflight"] = await call("OPTIONS", "/analyze", {
        "origin": "http://evil.example",
        "access-control-request-method": "POST",
        "access-control-request-headers": "content-type",
    })
    results["post_no_token"] = await call("POST", "/analyze", {"origin": "http://evil.example"}, BODY)
    results["calls_after_no_token"] = len(calls)
    results["health_no_token"] = await call("GET", "/health", {})
    results["post_bad_token"] = await call("POST", "/analyze", {
        "content-type": "application/json", "x-cliodeck-token": "faux"}, BODY)
    results["post_token"] = await call("POST", "/analyze", {
        "content-type": "application/json", "x-cliodeck-token": "jeton-de-test"}, BODY)
    results["health_token"] = await call("GET", "/health", {"x-cliodeck-token": "jeton-de-test"})
    results["calls_total"] = len(calls)
    print("RESULT " + json.dumps(results))

asyncio.run(run())
`;

interface AsgiOut {
  status: number;
  headers: Record<string, string>;
}

interface DriverResult {
  preflight: AsgiOut;
  post_no_token: AsgiOut;
  calls_after_no_token: number;
  health_no_token: AsgiOut;
  post_bad_token: AsgiOut;
  post_token: AsgiOut;
  health_token: AsgiOut;
  calls_total: number;
}

function runDriver(token: string | undefined): DriverResult {
  const env: NodeJS.ProcessEnv = { ...process.env, PYTHONDONTWRITEBYTECODE: '1' };
  delete env.CLIODECK_TOPIC_TOKEN;
  if (token !== undefined) env.CLIODECK_TOPIC_TOKEN = token;
  const res = spawnSync(venvPython, ['-B', '-c', DRIVER, serviceDir], {
    env,
    encoding: 'utf-8',
    timeout: 60_000,
  });
  const line = (res.stdout ?? '').split('\n').find((l) => l.startsWith('RESULT '));
  if (!line) {
    throw new Error(`driver failed (status ${res.status}): ${res.stderr}`);
  }
  return JSON.parse(line.slice('RESULT '.length)) as DriverResult;
}

describe.skipIf(!hasVenv)('main.py — application FastAPI', () => {
  it('refuse toute requête sans le jeton, préflight compris, sans lancer d’analyse', () => {
    const r = runDriver('jeton-de-test');

    expect(r.preflight.headers['access-control-allow-origin']).toBeUndefined();
    expect(r.post_no_token.status).toBe(403);
    expect(r.calls_after_no_token).toBe(0);
    expect(r.health_no_token.status).toBe(403);
    expect(r.post_bad_token.status).toBe(403);
    expect(r.post_token.status).toBe(200);
    expect(r.health_token.status).toBe(200);
    expect(r.calls_total).toBe(1);
  });

  it('sans CLIODECK_TOPIC_TOKEN, tout est refusé', () => {
    const r = runDriver(undefined);

    expect(r.post_token.status).toBe(403);
    expect(r.health_token.status).toBe(403);
    expect(r.calls_total).toBe(0);
  });
});
