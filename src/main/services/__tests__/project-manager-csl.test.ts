/**
 * BT1-4 : le style CSL choisi par « Sélectionner » est copié à la racine du
 * projet. Quand la copie échouait, le chemin absolu de la source était gardé,
 * puis joint au dossier du projet : le chemin rendu au renderer n'existait
 * pas, et l'export écartait le style en silence.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'fs';
import { mkdtemp, rm } from 'fs/promises';
import os from 'os';
import path from 'path';

vi.mock('../config-manager.js', () => ({
  configManager: {
    addRecentProject: vi.fn(),
    removeRecentProject: vi.fn(),
    getRecentProjects: vi.fn(() => []),
  },
}));

import { ProjectManager } from '../project-manager.js';

let workDir: string;
let projectDir: string;
let projectFile: string;
let source: string;

beforeEach(async () => {
  workDir = await mkdtemp(path.join(os.tmpdir(), 'cliodeck-csl-'));
  projectDir = path.join(workDir, 'Projet');
  mkdirSync(projectDir);
  projectFile = path.join(projectDir, 'project.json');
  writeFileSync(projectFile, JSON.stringify({ name: 'Projet', type: 'article' }, null, 2));
  mkdirSync(path.join(workDir, 'Téléchargements'));
  source = path.join(workDir, 'Téléchargements', 'style.csl');
  writeFileSync(source, '<style/>');
});

afterEach(async () => {
  await rm(workDir, { recursive: true, force: true });
});

describe('setCSLPath : le chemin rendu existe', () => {
  it('copie réussie : le style est dans le projet, sous son nom', async () => {
    const result = await new ProjectManager().setCSLPath({ projectPath: projectFile, cslPath: source });

    expect(result).toMatchObject({ success: true, cslPath: path.join(projectDir, 'style.csl') });
    expect(result).not.toHaveProperty('notCopied');
    expect(JSON.parse(readFileSync(projectFile, 'utf8')).cslPath).toBe('style.csl');
  });

  it('copie impossible (un dossier porte ce nom dans le projet) : le style garde sa place, et c’est dit', async () => {
    mkdirSync(path.join(projectDir, 'style.csl'));

    const result = await new ProjectManager().setCSLPath({ projectPath: projectFile, cslPath: source });

    expect(result.success).toBe(true);
    expect(result.cslPath).toBe(source);
    expect(existsSync(result.cslPath!)).toBe(true);
    expect(result).toMatchObject({ notCopied: true });
  });
});
