import { describe, it, expect } from 'vitest';
import { detectEntities, highlightEntitiesInHtml } from '../ner-highlight';

describe('detectEntities', () => {
  it('detects standalone years', () => {
    const entities = detectEntities('La révolution de 1789 a changé la France.');
    const dates = entities.filter((e) => e.type === 'date');
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe('1789');
  });

  it('detects year ranges', () => {
    const entities = detectEntities('La guerre de 1914-1918 fut dévastatrice.');
    const dates = entities.filter((e) => e.type === 'date');
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe('1914-1918');
  });

  it('detects full dates', () => {
    const entities = detectEntities('Le 14 juillet 1789, la Bastille tomba.');
    const dates = entities.filter((e) => e.type === 'date');
    expect(dates.length).toBeGreaterThanOrEqual(1);
    expect(dates[0].text).toMatch(/14 juillet 1789/);
  });

  it('detects century references', () => {
    const entities = detectEntities('Au XIXe siècle, les empires coloniaux.');
    const dates = entities.filter((e) => e.type === 'date');
    expect(dates).toHaveLength(1);
    expect(dates[0].text).toBe('XIXe siècle');
  });

  it('detects proper nouns (multi-word capitalized)', () => {
    const entities = detectEntities('Karl Marx a écrit Le Capital.');
    const persons = entities.filter((e) => e.type === 'person');
    expect(persons).toHaveLength(1);
    expect(persons[0].text).toBe('Karl Marx');
  });

  it('does not flag common sentence starts as entities', () => {
    const entities = detectEntities('Les hommes sont mortels.');
    const persons = entities.filter((e) => e.type === 'person');
    expect(persons).toHaveLength(0);
  });
});

describe('highlightEntitiesInHtml', () => {
  it('wraps detected entities in mark tags', () => {
    const html = '<p>En 1789, la révolution éclate.</p>';
    const result = highlightEntitiesInHtml(html);
    expect(result).toContain('<mark class="ner ner--date"');
    expect(result).toContain('1789');
  });

  it('does not highlight inside code blocks', () => {
    const html = '<code>year = 1789</code>';
    const result = highlightEntitiesInHtml(html);
    expect(result).not.toContain('<mark');
  });

  it('preserves HTML structure', () => {
    const html = '<p>Hello <strong>world</strong></p>';
    const result = highlightEntitiesInHtml(html);
    expect(result).toContain('<strong>world</strong>');
  });
});
