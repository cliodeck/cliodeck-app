import { WidgetType } from '@codemirror/view';

/**
 * Widgets DOM du rendu live. Construction DOM directe exclusivement —
 * jamais d'innerHTML avec du contenu du document (plan CM6, P2).
 */

export class CheckboxWidget extends WidgetType {
  constructor(readonly checked: boolean) {
    super();
  }

  override eq(other: CheckboxWidget): boolean {
    return other.checked === this.checked;
  }

  toDOM(): HTMLElement {
    const input = document.createElement('input');
    input.type = 'checkbox';
    input.checked = this.checked;
    input.className = 'cm-live-task';
    input.setAttribute('aria-label', 'toggle task');
    return input;
  }

  // Laisser l'éditeur recevoir le mousedown : le plugin le traduit en
  // transaction sur le texte source (jamais de mutation DOM).
  override ignoreEvent(): boolean {
    return false;
  }
}

export class HrWidget extends WidgetType {
  override eq(): boolean {
    return true;
  }

  toDOM(): HTMLElement {
    const span = document.createElement('span');
    span.className = 'cm-live-hr';
    return span;
  }
}

export class ImageWidget extends WidgetType {
  constructor(
    readonly src: string,
    readonly alt: string,
    readonly resolveSrc?: (src: string) => string | null
  ) {
    super();
  }

  override eq(other: ImageWidget): boolean {
    return other.src === this.src && other.alt === this.alt;
  }

  toDOM(): HTMLElement {
    const wrap = document.createElement('div');
    wrap.className = 'cm-live-image';
    const resolved = this.resolveSrc ? this.resolveSrc(this.src) : this.src;
    if (!resolved) {
      wrap.appendChild(this.placeholder());
      return wrap;
    }
    const img = document.createElement('img');
    img.alt = this.alt;
    img.draggable = false;
    img.onerror = () => {
      // Chemin relatif sans projet, fichier manquant... : placeholder discret
      // plutôt qu'une icône d'image cassée.
      img.remove();
      wrap.appendChild(this.placeholder());
    };
    img.src = resolved;
    wrap.appendChild(img);
    return wrap;
  }

  private placeholder(): HTMLElement {
    const box = document.createElement('span');
    box.className = 'cm-live-image-missing';
    box.textContent = `🖼 ${this.alt || this.src}`;
    box.title = this.src;
    return box;
  }

  override get estimatedHeight(): number {
    return 120;
  }

  override ignoreEvent(): boolean {
    return true;
  }
}
