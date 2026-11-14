/**
 * L'export PDF d'une présentation rend une page par diapositive.
 *
 * C'est le seul endroit de l'application qui imprime par Chromium
 * (`printToPDF` dans une fenêtre cachée) : il dépend de la version
 * d'Electron, et aucun test unitaire ne peut le couvrir. Il a longtemps rendu
 * un PDF d'une seule diapositive sur des pages de plusieurs kilomètres —
 * taille donnée en microns là où Electron attend des pouces, mode impression
 * de reveal.js jamais déclenché —, puis a cessé de fonctionner avec
 * Electron 43, qui refuse cette taille.
 *
 * Le chemin de sortie a une apostrophe et une esperluette, comme celui que la fenêtre
 * propose pour un projet nommé « Séminaire d'histoire » : la validation de l'IPC les
 * refusait, reste d'un temps où ce chemin passait par un shell (S12-1-3).
 *
 * Une diapositive cite du code qui contient `---` et `Note:`, puis porte une vraie note : le
 * plugin markdown de reveal.js redécoupait chaque section dans le navigateur, sans rien savoir
 * des blocs de code. Le `---` du code ajoutait une page, et la vraie note s'imprimait sur la
 * diapositive (S12-2-3). Le texte du PDF, lu par pdftotext quand il est là, le montre : le
 * code reste entier, la note n'est pas imprimée (`showNotes` est faux). Une cinquième diapositive
 * cache un `Note:` dans un commentaire (Cmd+/) et en cite un en tête d'un bloc de code indenté :
 * ni l'un ni l'autre n'ouvre de notes, et le texte qui les suit reste projeté (revue de L10-3).
 * Deux autres portent un `Note:` tapé juste sous un élément HTML refermé, puis sous un `</div>` :
 * pour CommonMark, il est dans le bloc HTML, et la note s'imprimait sur la diapositive (seconde
 * revue de L10-3). Elle reste privée.
 *
 * reveal.js est inclus dans la page (L09-12), du cache de l'app ou, la première fois, de son CDN :
 * le premier export d'un userData neuf demande le réseau, et le test est sauté si l'export le dit
 * (`presentation.assetsUnavailable`). Il ne sonde plus le CDN à part : une sonde de 5 s l'a fait
 * sauter deux fois alors que le CDN répondait. Les polices du thème (Source Sans Pro pour `black`,
 * importée par un chemin relatif au CDN) sont incluses de même : `pdffonts` les cherche dans le PDF,
 * qui sortait en Helvetica (revue de L09-12). Le second export se fait sans réseau : toute requête
 * http(s) de la session est annulée et notée, téléchargements du main compris (`net.fetch` passe
 * par la session), et aucune ne doit partir. C'est le seul test qui passe par le vrai plugin, et
 * par la vraie attente de la mise en pages (`pdf-ready`) : à relancer si `REVEAL_VERSION` change.
 */

import { test, expect } from '@playwright/test';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, rmSync } from 'node:fs';
import { createServer } from 'node:http';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { crc32, deflateSync } from 'node:zlib';
import { pdftotextAvailable, toolEnv } from '../backend/__tests__/helpers/native-guards';
import { launchApp } from './_helpers/launch';

const DECK = [
  '# Les archives et la machine\n\nIntroduction',
  '## Deuxième diapositive\n\n- premier point\n- second point',
  '## Troisième diapositive\n\nConclusion',
  '## Exemple de syntaxe\n\n```markdown\n---\nNote: CODENOTE dans le code\n```\n\nSuite du texte visible.\n\n' +
    'Note:\nVRAIENOTE à ne pas projeter.',
  '## Commentaire\n\n<!--\nNote: NOTECOMMENTEE\n-->\n\nTexte après le commentaire.\n\n' +
    '    Note: CODEINDENTE\n    x <- 1\n\nSuite après le code indenté.',
  '## Légende\n\n<p class="legende">Légende de la carte.</p>\nNote: NOTEAPRESHTML à ne pas projeter.',
  '## Colonnes\n\n<div class="colonnes">\n\nTexte en colonnes.\n\n</div>\nNote: NOTEAPRESDIV à ne pas projeter.',
].join('\n\n---\n\n');

type ExportResponse = {
  success: boolean;
  outputPath?: string;
  error?: string;
  errorCode?: string;
  warnings?: unknown[];
};

type ExportBridge = {
  electron: {
    revealJsExport: { exportPDF: (options: object) => Promise<ExportResponse> };
    pdf: { extractMetadata: (filePath: string) => Promise<unknown> };
  };
};

test('l’export PDF d’une présentation rend une page par diapositive, hors ligne compris', async () => {
  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const outDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-diapos-'));
  const outputPath = join(outDir, "Séminaire d'histoire", 'S&P présentation.pdf');

  const exportPdf = () =>
    window.evaluate(
      (options) => (window as unknown as ExportBridge).electron.revealJsExport.exportPDF(options),
      {
        projectPath: join(outDir, 'project.json'),
        content: DECK,
        outputPath,
        metadata: { title: 'Présentation E2E' },
      },
    );

  /** Le PDF relu : une diapositive par page, code entier, notes absentes. */
  const expectSlides = async () => {
    // Le PDF est relu par le worker d'extraction de l'application : une
    // diapositive par page, ni plus (pages vides) ni moins (diapositives perdues).
    const response = await window.evaluate(
      (filePath) => (window as unknown as ExportBridge).electron.pdf.extractMetadata(filePath),
      outputPath,
    );
    const payload = response as { metadata?: { pageCount?: number } };
    const metadata = payload.metadata ?? (payload as { pageCount?: number });
    if (pdftotextAvailable()) {
      // pdffonts vient avec pdftotext (Poppler) : la police du thème, pas une police de repli.
      const fonts = execFileSync('pdffonts', [outputPath], { encoding: 'utf8', env: toolEnv() });
      expect(fonts).toMatch(/SourceSansPro/);
      expect(fonts).not.toMatch(/Helvetica/);
      const text = execFileSync('pdftotext', [outputPath, '-'], { encoding: 'utf8', env: toolEnv() });
      // reveal.js a mis la page en forme : le titre est un titre, pas une ligne `# …` brute.
      expect(text).toMatch(/Les archives et la\s+machine/);
      expect(text).not.toContain('# Les archives');
      expect(text).not.toContain('VRAIENOTE');
      expect(text).toContain('Note: CODENOTE dans le code');
      expect(text).toContain('Suite du texte visible.');
      expect(text).not.toContain('NOTECOMMENTEE');
      expect(text).toContain('Texte après le commentaire.');
      expect(text).toContain('Note: CODEINDENTE');
      expect(text).toContain('Suite après le code indenté.');
      expect(text).toContain('Légende de la carte.');
      expect(text).toContain('Texte en colonnes.');
      expect(text).not.toMatch(/NOTEAPRES|Note: NOTE/);
    }
    expect(metadata.pageCount).toBe(7);
  };

  try {
    const first = await exportPdf();
    test.skip(
      first.errorCode === 'presentation.assetsUnavailable',
      'reveal.js ni en cache ni téléchargeable : premier export PDF non vérifiable hors ligne.',
    );
    expect(first.error).toBeUndefined();
    expect(first).toMatchObject({ success: true });
    expect(first.warnings).toBeUndefined();
    await expectSlides();

    // Plus de réseau : toute requête http(s) de la session est annulée, et notée. Les
    // téléchargements du main passent par `net.fetch`, donc par la session ; la fenêtre
    // d'impression aussi. `enableNetworkEmulation({ offline: true })` ne vaut que pour les pages
    // déjà ouvertes, et la fenêtre d'impression, créée après, atteignait encore le CDN (mesuré).
    rmSync(outputPath);
    await app.evaluate(async ({ session }) => {
      const blocked: string[] = [];
      (globalThis as { e2eBlockedRequests?: string[] }).e2eBlockedRequests = blocked;
      session.defaultSession.webRequest.onBeforeRequest({ urls: ['http://*/*', 'https://*/*'] }, (details, callback) => {
        blocked.push(details.url);
        callback({ cancel: true });
      });
    });

    const offline = await exportPdf();
    expect(offline.error).toBeUndefined();
    expect(offline).toMatchObject({ success: true });
    expect(offline.warnings).toBeUndefined();
    await expectSlides();
    // Rien n'est parti au dehors : ni reveal.js, ni ses polices, ni Google Fonts.
    const blocked = await app.evaluate(() => (globalThis as { e2eBlockedRequests?: string[] }).e2eBlockedRequests ?? []);
    expect(blocked.filter((url) => !/^https?:\/\/(127\.0\.0\.1|localhost)[:/]/.test(url))).toEqual([]);
  } finally {
    await app.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});

/** Un PNG valide (CRC justes), en dégradé : Chromium le décode et l'imprime comme une image. */
function gradientPng(width: number, height: number): Buffer {
  const chunk = (type: string, data: Buffer) => {
    const body = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const length = Buffer.alloc(4);
    length.writeUInt32BE(data.length);
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(body));
    return Buffer.concat([length, body, crc]);
  };
  const header = Buffer.alloc(13);
  header.writeUInt32BE(width, 0);
  header.writeUInt32BE(height, 4);
  header[8] = 8; // 8 bits par composante
  header[9] = 2; // RVB ; compression, filtre et entrelacement à 0
  const rows = Array.from({ length: height }, (_, y) =>
    Buffer.from([0, ...Array.from({ length: width }, (_, x) => [x * 5, y * 7, 128]).flat()]),
  );
  return Buffer.concat([
    Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]),
    chunk('IHDR', header),
    chunk('IDAT', deflateSync(Buffer.concat(rows))),
    chunk('IEND', Buffer.alloc(0)),
  ]);
}

/**
 * Revue de L09-12, seconde passe : le chargement de la page d'impression était borné au total
 * (30 s), et une image distante qui arrivait lentement, mais arrivait (image d'archive en lien
 * direct, réseau d'hôtel), faisait échouer l'export. C'est l'inactivité qui est bornée : un serveur
 * local envoie l'image par petits morceaux, un par seconde, pendant 36 s, et le PDF sort avec elle.
 * Le seul test qui passe par le vrai protocole des outils de développement de Chromium, qui voit
 * chaque morceau reçu (`Network.dataReceived`) : à relancer à chaque montée d'Electron.
 */
test('une image distante lente qui arrive passe dans le PDF, au-delà du délai d’inactivité', async () => {
  test.setTimeout(180_000);
  const image = gradientPng(48, 32);
  const seconds = 36;
  const size = Math.ceil(image.length / seconds);
  const server = createServer((_request, response) => {
    response.writeHead(200, { 'content-type': 'image/png', 'content-length': String(image.length) });
    let sent = 0;
    const timer = setInterval(() => {
      const part = image.subarray(sent, sent + size);
      sent += part.length;
      if (sent >= image.length) {
        clearInterval(timer);
        response.end(part);
      } else response.write(part);
    }, 1000);
    response.on('close', () => clearInterval(timer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;

  const outcome = await launchApp();
  if (outcome.kind === 'skip') {
    server.close();
    test.skip(true, outcome.reason);
    return;
  }
  const { app, window, userDataDir } = outcome.value;
  const outDir = mkdtempSync(join(tmpdir(), 'cliodeck-e2e-image-lente-'));
  const outputPath = join(outDir, 'carte.pdf');

  try {
    const started = Date.now();
    const result = await window.evaluate(
      (options) => (window as unknown as ExportBridge).electron.revealJsExport.exportPDF(options),
      {
        projectPath: join(outDir, 'project.json'),
        content: `# Carte\n\n![Carte d'archive](http://127.0.0.1:${port}/carte.png)\n`,
        outputPath,
        metadata: { title: 'Image lente' },
      },
    );
    const elapsed = Date.now() - started;
    test.skip(
      result.errorCode === 'presentation.assetsUnavailable',
      'reveal.js ni en cache ni téléchargeable : export PDF non vérifiable.',
    );

    expect(result.error).toBeUndefined();
    expect(result).toMatchObject({ success: true });
    expect(result.warnings).toBeUndefined();
    // Au-delà du délai d'inactivité (30 s) : c'est bien la progression qui a fait attendre la page.
    expect(elapsed).toBeGreaterThan(30_000);
    if (pdftotextAvailable()) {
      // pdfimages vient avec pdftotext (Poppler) : l'image est dans le PDF.
      const list = execFileSync('pdfimages', ['-list', outputPath], { encoding: 'utf8', env: toolEnv() });
      expect(list.split('\n').slice(2).filter(Boolean)).toHaveLength(1);
    }
  } finally {
    await app.close();
    server.closeAllConnections();
    server.close();
    rmSync(userDataDir, { recursive: true, force: true });
    rmSync(outDir, { recursive: true, force: true });
  }
});
