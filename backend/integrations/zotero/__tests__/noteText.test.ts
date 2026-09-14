import { describe, it, expect } from 'vitest';
import { zoteroNoteToText } from '../noteText';

describe('zoteroNoteToText', () => {
  it('garde paragraphes et listes, retire le balisage', () => {
    const html =
      '<div data-schema-version="9"><h1>Lecture</h1><p>Idée <b>centrale</b></p><ul><li>un</li><li>deux</li></ul></div>';
    expect(zoteroNoteToText(html)).toBe('Lecture\nIdée centrale\n\n• un\n• deux');
  });

  it('décode les entités, espaces insécables comprises', () => {
    expect(zoteroNoteToText('<p>Braudel&nbsp;: &laquo;&#160;longue durée&#x202F;&raquo; &amp; Co</p>')).toBe(
      'Braudel : &laquo; longue durée &raquo; & Co'
    );
  });

  it('n’exécute rien : un script devient du texte inerte', () => {
    expect(zoteroNoteToText('<p>ok</p><script>alert(1)</script>')).toBe('ok\nalert(1)');
  });
});
