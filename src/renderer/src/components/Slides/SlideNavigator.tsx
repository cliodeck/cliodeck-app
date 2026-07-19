import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useTranslation } from 'react-i18next';
import { parseSlides, slideIndexAtOffset, type DeckInfo } from '@/editor/slides';
import { useEditorStore } from '../../stores/editorStore';
import './SlideNavigator.css';

/**
 * Navigateur de slides sur le découpage partagé (src/editor/slides.ts) :
 * plus de regex ligne-à-ligne — un `---` dans un bloc de code n'est pas un
 * séparateur, le frontmatter n'est pas une slide. Hiérarchie reveal
 * affichée : une slide ouvrant sur `##` est une verticale de la section
 * courante (indentée). La slide active suit le curseur (façade,
 * onSelectionChange) sans re-render à la frappe : l'état ne change qu'au
 * franchissement d'une frontière.
 */
export const SlideNavigator: React.FC = () => {
  const { t } = useTranslation('common');
  const content = useEditorStore((state) => state.content);
  const editorFacade = useEditorStore((state) => state.editorFacade);

  const deck = useMemo<DeckInfo>(() => parseSlides(content), [content]);
  const deckRef = useRef(deck);
  useEffect(() => {
    deckRef.current = deck;
  }, [deck]);

  const [activeIndex, setActiveIndex] = useState(0);
  useEffect(() => {
    if (!editorFacade?.onSelectionChange) return;
    return editorFacade.onSelectionChange((offset) => {
      const next = slideIndexAtOffset(deckRef.current, offset);
      setActiveIndex((prev) => (prev === next ? prev : next));
    });
  }, [editorFacade]);

  const handleSlideClick = (lineNumber: number) => {
    editorFacade?.revealLine(lineNumber);
  };

  return (
    <div className="slide-navigator">
      <div className="slide-navigator-header">
        <span className="slide-navigator-count">
          {t('slides.navigator.count', { count: deck.slides.length })}
        </span>
      </div>
      <ul className="slide-navigator-list">
        {deck.slides.map((slide) => (
          <li
            key={slide.index}
            className={[
              'slide-navigator-item',
              slide.index === activeIndex ? 'active' : '',
              slide.level === 2 ? 'slide-navigator-item--sub' : '',
            ]
              .filter(Boolean)
              .join(' ')}
            onClick={() => handleSlideClick(slide.line)}
            title={slide.title ?? t('slides.navigator.untitled', { index: slide.index + 1 })}
          >
            <span className="slide-number">{slide.index + 1}</span>
            <span className="slide-title">
              {slide.title ?? t('slides.navigator.untitled', { index: slide.index + 1 })}
            </span>
          </li>
        ))}
      </ul>
    </div>
  );
};
