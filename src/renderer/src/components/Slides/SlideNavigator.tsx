import React, { useMemo } from 'react';
import { useEditorStore } from '../../stores/editorStore';
import './SlideNavigator.css';

interface Slide {
  index: number;
  title: string;
  lineNumber: number;
}

function parseSlidesFromContent(content: string): Slide[] {
  const slides: Slide[] = [];
  const lines = content.split('\n');
  let slideIndex = 0;
  let currentSlideStartLine = 1;
  let currentSlideTitle = '';

  const pushSlide = (_endLine: number) => {
    slides.push({
      index: slideIndex,
      title: currentSlideTitle || `Slide ${slideIndex + 1}`,
      lineNumber: currentSlideStartLine,
    });
    slideIndex++;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();

    if (line === '---') {
      pushSlide(i + 1);
      currentSlideStartLine = i + 2;
      currentSlideTitle = '';
    } else if ((line.startsWith('## ') || line.startsWith('# ')) && currentSlideTitle === '') {
      currentSlideTitle = line.replace(/^#+\s+/, '');
    }
  }

  // Last slide
  if (slideIndex === 0 || lines.length > 0) {
    slides.push({
      index: slideIndex,
      title: currentSlideTitle || `Slide ${slideIndex + 1}`,
      lineNumber: currentSlideStartLine,
    });
  }

  return slides;
}

interface SlideNavigatorProps {
  activeLineNumber?: number;
}

export const SlideNavigator: React.FC<SlideNavigatorProps> = ({ activeLineNumber }) => {
  const content = useEditorStore((state) => state.content);
  const monacoEditor = useEditorStore((state) => state.monacoEditor);

  const slides = useMemo(() => parseSlidesFromContent(content), [content]);

  const handleSlideClick = (lineNumber: number) => {
    if (monacoEditor) {
      monacoEditor.revealLineInCenter(lineNumber);
      monacoEditor.setPosition({ lineNumber, column: 1 });
      monacoEditor.focus();
    }
  };

  const activeSlideIndex = useMemo(() => {
    if (!activeLineNumber) return 0;
    let active = 0;
    for (let i = 0; i < slides.length; i++) {
      if (slides[i].lineNumber <= activeLineNumber) {
        active = i;
      }
    }
    return active;
  }, [slides, activeLineNumber]);

  return (
    <div className="slide-navigator">
      <div className="slide-navigator-header">
        <span className="slide-navigator-count">{slides.length} slide{slides.length !== 1 ? 's' : ''}</span>
      </div>
      <ul className="slide-navigator-list">
        {slides.map((slide) => (
          <li
            key={slide.index}
            className={`slide-navigator-item ${slide.index === activeSlideIndex ? 'active' : ''}`}
            onClick={() => handleSlideClick(slide.lineNumber)}
            title={slide.title}
          >
            <span className="slide-number">{slide.index + 1}</span>
            <span className="slide-title">{slide.title}</span>
          </li>
        ))}
      </ul>
    </div>
  );
};
