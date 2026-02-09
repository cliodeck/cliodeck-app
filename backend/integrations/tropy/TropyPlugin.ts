import * as fs from 'fs';
import * as path from 'path';
import Database from 'better-sqlite3';

// MARK: - Types Tropy

export interface TropyItem {
  id: number;
  template: string;
  title?: string;
  date?: string;
  creator?: string;
  type?: string;
  collection?: string;
  archive?: string;
  tags: string[];
  notes: TropyNote[];
  photos: TropyPhoto[];
}

export interface TropyPhoto {
  id: number;
  path: string;
  filename: string;
  title?: string;
  notes: TropyNote[];
  selections: TropySelection[];
}

export interface TropySelection {
  id: number;
  x: number;
  y: number;
  width: number;
  height: number;
  angle: number;
  notes: TropyNote[];
}

export interface TropyNote {
  id: number;
  html: string;
  text: string;
}

export interface TropyProject {
  name: string;
  items: TropyItem[];
}

export interface ImportResult {
  itemCount: number;
  photoCount: number;
  noteCount: number;
  outputDirectory: string;
  errors: string[];
}

// MARK: - TropyPlugin

export class TropyPlugin {
  private db: Database.Database | null = null;

  /**
   * Ouvre un projet Tropy (.tpy)
   */
  openProject(tpyPath: string): void {
    if (!fs.existsSync(tpyPath)) {
      throw new Error(`Tropy project not found: ${tpyPath}`);
    }

    this.db = new Database(tpyPath, { readonly: true });
  }

  /**
   * Ferme le projet
   */
  closeProject(): void {
    if (this.db) {
      this.db.close();
      this.db = null;
    }
  }

  /**
   * Lit le nom du projet
   */
  getProjectName(): string {
    if (!this.db) throw new Error('No project opened');

    try {
      const result = this.db.prepare('SELECT name FROM project LIMIT 1').get() as {
        name: string;
      } | undefined;
      return result?.name || 'Unnamed Project';
    } catch {
      return 'Unnamed Project';
    }
  }

  /**
   * Liste tous les items du projet
   */
  listItems(): TropyItem[] {
    if (!this.db) throw new Error('No project opened');

    const items: TropyItem[] = [];

    try {
      // Récupérer les items
      const itemRows = this.db.prepare('SELECT * FROM items').all() as Array<{
        id: number;
        template: string;
      }>;

      for (const itemRow of itemRows) {
        const item: TropyItem = {
          id: itemRow.id,
          template: itemRow.template,
          tags: [],
          notes: [],
          photos: [],
        };

        // Récupérer les métadonnées (title, date, creator, etc.)
        const metadata = this.getItemMetadata(itemRow.id);
        Object.assign(item, metadata);

        // Récupérer les tags
        item.tags = this.getItemTags(itemRow.id);

        // Récupérer les notes
        item.notes = this.getItemNotes(itemRow.id);

        // Récupérer les photos
        item.photos = this.getItemPhotos(itemRow.id);

        items.push(item);
      }

      return items;
    } catch (error) {
      console.error('Failed to list items:', error);
      return [];
    }
  }

  /**
   * Importe un projet Tropy dans un dossier local
   */
  async importProject(tpyPath: string, targetDirectory: string): Promise<ImportResult> {
    const result: ImportResult = {
      itemCount: 0,
      photoCount: 0,
      noteCount: 0,
      outputDirectory: targetDirectory,
      errors: [],
    };

    try {
      // Ouvrir le projet
      this.openProject(tpyPath);

      // Créer le dossier de destination
      if (!fs.existsSync(targetDirectory)) {
        fs.mkdirSync(targetDirectory, { recursive: true });
      }

      // Récupérer tous les items
      const items = this.listItems();
      result.itemCount = items.length;

      console.log(`📦 Importing ${items.length} Tropy items...`);

      // Importer chaque item
      for (const item of items) {
        try {
          await this.importItem(item, targetDirectory);
          result.photoCount += item.photos.length;
          result.noteCount += item.notes.length + this.countPhotoNotes(item.photos);
        } catch (error) {
          result.errors.push(`Failed to import item ${item.id}: ${error}`);
        }
      }

      console.log(`\n✅ Import terminé:`);
      console.log(`   - ${result.itemCount} items`);
      console.log(`   - ${result.photoCount} photos`);
      console.log(`   - ${result.noteCount} notes`);
      console.log(`   - ${result.errors.length} erreurs`);

      return result;
    } finally {
      this.closeProject();
    }
  }

  // MARK: - Private Methods

  private getItemMetadata(itemId: number): Partial<TropyItem> {
    if (!this.db) return {};

    try {
      const metadataRows = this.db
        .prepare('SELECT property, value FROM metadata WHERE id = ?')
        .all(itemId) as Array<{ property: string; value: string }>;

      const metadata: any = {};

      for (const row of metadataRows) {
        const propertyName = this.extractPropertyName(row.property);
        if (propertyName) {
          metadata[propertyName] = row.value;
        }
      }

      return metadata;
    } catch {
      return {};
    }
  }

  private extractPropertyName(propertyURI: string): string | null {
    // Extraire le nom de la propriété depuis l'URI
    // Ex: "http://purl.org/dc/elements/1.1/title" → "title"
    const match = propertyURI.match(/[/#]([^/#]+)$/);
    return match ? match[1] : null;
  }

  private getItemTags(itemId: number): string[] {
    if (!this.db) return [];

    try {
      const tagRows = this.db
        .prepare('SELECT name FROM tags WHERE id IN (SELECT tag_id FROM taggings WHERE id = ?)')
        .all(itemId) as Array<{ name: string }>;

      return tagRows.map((row) => row.name);
    } catch {
      return [];
    }
  }

  private getItemNotes(itemId: number): TropyNote[] {
    if (!this.db) return [];

    try {
      const noteRows = this.db
        .prepare('SELECT id, html, text FROM notes WHERE id = ?')
        .all(itemId) as Array<{ id: number; html: string; text: string }>;

      return noteRows.map((row) => ({
        id: row.id,
        html: row.html,
        text: row.text,
      }));
    } catch {
      return [];
    }
  }

  private getItemPhotos(itemId: number): TropyPhoto[] {
    if (!this.db) return [];

    try {
      const photoRows = this.db
        .prepare('SELECT id, path FROM photos WHERE item_id = ?')
        .all(itemId) as Array<{ id: number; path: string }>;

      return photoRows.map((row) => {
        const photo: TropyPhoto = {
          id: row.id,
          path: row.path,
          filename: path.basename(row.path),
          notes: this.getPhotoNotes(row.id),
          selections: this.getPhotoSelections(row.id),
        };

        return photo;
      });
    } catch {
      return [];
    }
  }

  private getPhotoNotes(photoId: number): TropyNote[] {
    if (!this.db) return [];

    try {
      const noteRows = this.db
        .prepare('SELECT id, html, text FROM notes WHERE photo_id = ?')
        .all(photoId) as Array<{ id: number; html: string; text: string }>;

      return noteRows.map((row) => ({
        id: row.id,
        html: row.html,
        text: row.text,
      }));
    } catch {
      return [];
    }
  }

  private getPhotoSelections(photoId: number): TropySelection[] {
    if (!this.db) return [];

    try {
      const selectionRows = this.db
        .prepare('SELECT id, x, y, width, height, angle FROM selections WHERE photo_id = ?')
        .all(photoId) as Array<{
        id: number;
        x: number;
        y: number;
        width: number;
        height: number;
        angle: number;
      }>;

      return selectionRows.map((row) => ({
        id: row.id,
        x: row.x,
        y: row.y,
        width: row.width,
        height: row.height,
        angle: row.angle,
        notes: this.getSelectionNotes(row.id),
      }));
    } catch {
      return [];
    }
  }

  private getSelectionNotes(selectionId: number): TropyNote[] {
    if (!this.db) return [];

    try {
      const noteRows = this.db
        .prepare('SELECT id, html, text FROM notes WHERE selection_id = ?')
        .all(selectionId) as Array<{ id: number; html: string; text: string }>;

      return noteRows.map((row) => ({
        id: row.id,
        html: row.html,
        text: row.text,
      }));
    } catch {
      return [];
    }
  }

  private async importItem(item: TropyItem, targetDirectory: string): Promise<void> {
    // Créer un dossier pour l'item
    const itemDir = path.join(
      targetDirectory,
      this.sanitizeFilename(item.title || `item-${item.id}`)
    );

    if (!fs.existsSync(itemDir)) {
      fs.mkdirSync(itemDir, { recursive: true });
    }

    // Créer un fichier markdown avec les métadonnées
    const markdown = this.generateItemMarkdown(item);
    fs.writeFileSync(path.join(itemDir, 'index.md'), markdown, 'utf-8');

    // Copier les photos
    for (const photo of item.photos) {
      try {
        if (fs.existsSync(photo.path)) {
          const destPath = path.join(itemDir, photo.filename);
          fs.copyFileSync(photo.path, destPath);
        }
      } catch (error) {
        console.warn(`Failed to copy photo ${photo.path}:`, error);
      }
    }
  }

  private generateItemMarkdown(item: TropyItem): string {
    let md = `# ${item.title || 'Sans titre'}\n\n`;

    // Métadonnées
    md += '## Métadonnées\n\n';
    if (item.creator) md += `**Créateur:** ${item.creator}\n`;
    if (item.date) md += `**Date:** ${item.date}\n`;
    if (item.type) md += `**Type:** ${item.type}\n`;
    if (item.collection) md += `**Collection:** ${item.collection}\n`;
    if (item.archive) md += `**Archive:** ${item.archive}\n`;

    if (item.tags.length > 0) {
      md += `\n**Tags:** ${item.tags.join(', ')}\n`;
    }

    // Notes de l'item
    if (item.notes.length > 0) {
      md += '\n## Notes\n\n';
      for (const note of item.notes) {
        md += `${note.text}\n\n`;
      }
    }

    // Photos
    if (item.photos.length > 0) {
      md += '\n## Photos\n\n';
      for (const photo of item.photos) {
        md += `### ${photo.filename}\n\n`;
        md += `![${photo.filename}](./${photo.filename})\n\n`;

        // Notes de la photo
        if (photo.notes.length > 0) {
          md += '**Notes:**\n\n';
          for (const note of photo.notes) {
            md += `${note.text}\n\n`;
          }
        }
      }
    }

    return md;
  }

  private sanitizeFilename(filename: string): string {
    return filename
      .replace(/[<>:"/\\|?*]/g, '_')
      .replace(/\s+/g, '_')
      .replace(/_+/g, '_')
      .substring(0, 100);
  }

  private countPhotoNotes(photos: TropyPhoto[]): number {
    return photos.reduce((sum, photo) => {
      return (
        sum +
        photo.notes.length +
        photo.selections.reduce((s, sel) => s + sel.notes.length, 0)
      );
    }, 0);
  }
}
