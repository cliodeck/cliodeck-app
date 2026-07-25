/**
 * Badge « source signalée » (#8) — helpers partagés entre la liste des
 * sources (AssistantChat) et le détail (SourcePopover).
 */
import type { SecurityEvent } from '@backend/security/events';

type Severity = 'low' | 'medium' | 'high';

/** Sévérité d'un événement ; `external_url` n'en porte pas → low. */
export function eventSeverity(e: SecurityEvent): Severity {
  return 'severity' in e ? e.severity : 'low';
}

const ORDER: Record<Severity, number> = { low: 0, medium: 1, high: 2 };

export function highestSeverity(events: SecurityEvent[]): Severity {
  return events.reduce<Severity>(
    (acc, e) => (ORDER[eventSeverity(e)] > ORDER[acc] ? eventSeverity(e) : acc),
    'low'
  );
}

/** Couleur du badge selon la sévérité la plus haute (rouge/ambre/discret). */
export function securityBadgeColor(events: SecurityEvent[]): string {
  const s = highestSeverity(events);
  if (s === 'high') return 'var(--color-danger)';
  if (s === 'medium') return 'var(--color-warning)';
  return 'var(--text-tertiary)';
}

/** Libellé court du motif d'un événement (pattern / URL / détail). */
export function eventDetail(e: SecurityEvent): string {
  switch (e.kind) {
    case 'suspicious_instruction':
    case 'prompt_injection_blocked':
      return e.pattern;
    case 'external_url':
      return e.url;
    case 'unusual_encoding':
      return e.detail;
  }
  // Union exhaustive — inatteignable, mais noImplicitReturns exige une fin.
  return '';
}
