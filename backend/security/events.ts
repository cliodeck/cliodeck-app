/**
 * Security event types (fusion step 4.5bis, claw-code lesson 6.2 —
 * *events over scraped prose*).
 *
 * Discriminated union shared between the SourceInspector (emitter, main
 * process) and the renderer (aggregator). Persisted as JSONL at
 * `.cliodeck/security-events.jsonl` so dashboards, audits, and
 * follow-up tooling reason over typed records, not free text.
 *
 * Adding a variant: extend the union here, then exhaustive `switch`
 * narrowing across all consumers fails the build until each handles it.
 */

import type { SourceId } from '../types/source.js';

export type SecuritySeverity = 'low' | 'medium' | 'high';

export type SecurityEvent =
  | {
      kind: 'suspicious_instruction';
      source: SourceId;
      chunkId: string;
      pattern: string;
      severity: SecuritySeverity;
      at: string;
    }
  | {
      kind: 'external_url';
      source: SourceId;
      chunkId: string;
      url: string;
      at: string;
    }
  | {
      kind: 'unusual_encoding';
      source: SourceId;
      chunkId: string;
      detail: string;
      severity: SecuritySeverity;
      at: string;
    }
  | {
      kind: 'prompt_injection_blocked';
      source: SourceId;
      chunkId: string;
      mode: 'warn' | 'audit' | 'block';
      pattern: string;
      severity: SecuritySeverity;
      at: string;
    };

export type SecurityEventKind = SecurityEvent['kind'];

/**
 * Refus du garde de navigation du main : la fenêtre a tenté d'ouvrir une URL
 * externe sans geste de l'historien (meta refresh, `location` changé,
 * redirection, lien activé par un script). Rien n'a été ouvert. Ce n'est pas
 * un événement d'extrait — ni source ni chunk —, il ne remonte pas au chat.
 */
export interface NavigationBlockedEvent {
  kind: 'external_navigation_blocked';
  url: string;
  at: string;
}

/** Tout ce que reçoit `.cliodeck/security-events.jsonl`. */
export type SecurityLogEvent = SecurityEvent | NavigationBlockedEvent;

export type SecurityLogEventKind = SecurityLogEvent['kind'];
