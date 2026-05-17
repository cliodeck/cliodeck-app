/**
 * OnboardingWizard — conversational onboarding for new projects.
 *
 * Inspired by The Historian's Desktop: a short "interview" that asks the
 * researcher about their topic, sources, and preferred language, then
 * generates an initial .cliohints file so the LLM immediately has context.
 *
 * Appears as a modal after project creation. Each step is a simple
 * question/answer — no LLM needed.
 */

import React, { useState, useCallback, useRef, useEffect } from 'react';
import { useTranslation } from 'react-i18next';
import { ArrowRight, Check, X } from 'lucide-react';
import './OnboardingWizard.css';

type Step = 'topic' | 'period' | 'sources' | 'language' | 'done';

interface OnboardingAnswers {
  topic: string;
  period: string;
  sources: ('zotero' | 'tropy' | 'pdfs' | 'obsidian')[];
  language: 'fr' | 'en' | 'de';
}

interface Props {
  projectName: string;
  onComplete: (hints: string) => void;
  onSkip: () => void;
}

const STEPS: Step[] = ['topic', 'period', 'sources', 'language', 'done'];

export const OnboardingWizard: React.FC<Props> = ({ projectName, onComplete, onSkip }) => {
  const { t } = useTranslation('common');
  const [currentStep, setCurrentStep] = useState<Step>('topic');
  const [answers, setAnswers] = useState<OnboardingAnswers>({
    topic: '',
    period: '',
    sources: [],
    language: 'fr',
  });
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
  }, [currentStep]);

  const stepIndex = STEPS.indexOf(currentStep);
  const progress = Math.round((stepIndex / (STEPS.length - 1)) * 100);

  const advance = useCallback(() => {
    const idx = STEPS.indexOf(currentStep);
    if (idx < STEPS.length - 1) {
      const next = STEPS[idx + 1];
      setCurrentStep(next);
      if (next === 'done') {
        const hints = generateHints(projectName, answers);
        onComplete(hints);
      }
    }
  }, [currentStep, answers, projectName, onComplete]);

  const handleKeyDown = useCallback(
    (e: React.KeyboardEvent) => {
      if (e.key === 'Enter' && currentStep !== 'sources') {
        e.preventDefault();
        if (currentStep === 'topic' && !answers.topic.trim()) return;
        advance();
      }
    },
    [advance, currentStep, answers.topic]
  );

  const toggleSource = (src: OnboardingAnswers['sources'][number]) => {
    setAnswers((prev) => ({
      ...prev,
      sources: prev.sources.includes(src)
        ? prev.sources.filter((s) => s !== src)
        : [...prev.sources, src],
    }));
  };

  return (
    <div className="onboarding-wizard" onClick={onSkip}>
      <div className="onboarding-wizard__card" onClick={(e) => e.stopPropagation()}>
        <button
          type="button"
          className="onboarding-wizard__close"
          onClick={onSkip}
          title={t('onboarding.skip')}
        >
          <X size={18} />
        </button>

        <div className="onboarding-wizard__progress">
          <div
            className="onboarding-wizard__progress-bar"
            style={{ width: `${progress}%` }}
          />
        </div>

        <div className="onboarding-wizard__conversation">
          {/* Step: Topic */}
          {currentStep === 'topic' && (
            <div className="onboarding-wizard__step">
              <p className="onboarding-wizard__question">
                {t('onboarding.topicQuestion', { name: projectName })}
              </p>
              <input
                ref={inputRef}
                type="text"
                className="onboarding-wizard__input"
                value={answers.topic}
                onChange={(e) => setAnswers((a) => ({ ...a, topic: e.target.value }))}
                onKeyDown={handleKeyDown}
                placeholder={t('onboarding.topicPlaceholder')}
              />
              <div className="onboarding-wizard__nav">
                <button
                  type="button"
                  className="onboarding-wizard__btn"
                  onClick={advance}
                  disabled={!answers.topic.trim()}
                >
                  {t('onboarding.next')} <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Step: Period */}
          {currentStep === 'period' && (
            <div className="onboarding-wizard__step">
              <p className="onboarding-wizard__question">
                {t('onboarding.periodQuestion')}
              </p>
              <input
                ref={inputRef}
                type="text"
                className="onboarding-wizard__input"
                value={answers.period}
                onChange={(e) => setAnswers((a) => ({ ...a, period: e.target.value }))}
                onKeyDown={handleKeyDown}
                placeholder={t('onboarding.periodPlaceholder')}
              />
              <div className="onboarding-wizard__nav">
                <button
                  type="button"
                  className="onboarding-wizard__btn"
                  onClick={advance}
                >
                  {t('onboarding.next')} <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Step: Sources */}
          {currentStep === 'sources' && (
            <div className="onboarding-wizard__step">
              <p className="onboarding-wizard__question">
                {t('onboarding.sourcesQuestion')}
              </p>
              <div className="onboarding-wizard__chips">
                {(['pdfs', 'zotero', 'tropy', 'obsidian'] as const).map((src) => (
                  <button
                    key={src}
                    type="button"
                    className={`onboarding-wizard__chip ${answers.sources.includes(src) ? 'is-selected' : ''}`}
                    onClick={() => toggleSource(src)}
                  >
                    {answers.sources.includes(src) && <Check size={12} />}
                    {t(`onboarding.source.${src}`)}
                  </button>
                ))}
              </div>
              <div className="onboarding-wizard__nav">
                <button
                  type="button"
                  className="onboarding-wizard__btn"
                  onClick={advance}
                >
                  {t('onboarding.next')} <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Step: Language */}
          {currentStep === 'language' && (
            <div className="onboarding-wizard__step">
              <p className="onboarding-wizard__question">
                {t('onboarding.languageQuestion')}
              </p>
              <div className="onboarding-wizard__chips">
                {(['fr', 'en', 'de'] as const).map((lang) => (
                  <button
                    key={lang}
                    type="button"
                    className={`onboarding-wizard__chip ${answers.language === lang ? 'is-selected' : ''}`}
                    onClick={() => setAnswers((a) => ({ ...a, language: lang }))}
                  >
                    {answers.language === lang && <Check size={12} />}
                    {t(`onboarding.lang.${lang}`)}
                  </button>
                ))}
              </div>
              <div className="onboarding-wizard__nav">
                <button
                  type="button"
                  className="onboarding-wizard__btn"
                  onClick={advance}
                >
                  {t('onboarding.finish')} <Check size={14} />
                </button>
              </div>
            </div>
          )}

          {/* Step: Done */}
          {currentStep === 'done' && (
            <div className="onboarding-wizard__step">
              <p className="onboarding-wizard__question">
                {t('onboarding.doneMessage')}
              </p>
              <div className="onboarding-wizard__nav">
                <button
                  type="button"
                  className="onboarding-wizard__btn"
                  onClick={onSkip}
                >
                  {t('onboarding.startWorking')} <ArrowRight size={14} />
                </button>
              </div>
            </div>
          )}
        </div>

        <button
          type="button"
          className="onboarding-wizard__skip-link"
          onClick={onSkip}
        >
          {t('onboarding.skipSetup')}
        </button>
      </div>
    </div>
  );
};

function generateHints(projectName: string, answers: OnboardingAnswers): string {
  const lines: string[] = [];
  lines.push(`# ${projectName}`);
  lines.push('');

  if (answers.topic) {
    lines.push(`## Research Topic`);
    lines.push('');
    lines.push(answers.topic);
    lines.push('');
  }

  if (answers.period) {
    lines.push(`## Period`);
    lines.push('');
    lines.push(answers.period);
    lines.push('');
  }

  if (answers.sources.length > 0) {
    lines.push(`## Sources`);
    lines.push('');
    const sourceLabels: Record<string, string> = {
      pdfs: 'PDF bibliography (secondary sources)',
      zotero: 'Zotero library',
      tropy: 'Tropy archive (primary sources)',
      obsidian: 'Obsidian vault (research notes)',
    };
    for (const src of answers.sources) {
      lines.push(`- ${sourceLabels[src]}`);
    }
    lines.push('');
  }

  lines.push(`## Language`);
  lines.push('');
  const langLabels: Record<string, string> = {
    fr: 'Respond in French.',
    en: 'Respond in English.',
    de: 'Respond in German.',
  };
  lines.push(langLabels[answers.language]);
  lines.push('');

  lines.push('## Instructions');
  lines.push('');
  lines.push('You are assisting a historian. Ground your answers in the available sources.');
  lines.push('Cite documents precisely. Distinguish primary from secondary sources.');
  if (answers.period) {
    lines.push(`Focus on the period: ${answers.period}.`);
  }
  lines.push('');

  return lines.join('\n');
}
