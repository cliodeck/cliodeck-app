import React from 'react';
import { useTranslation } from 'react-i18next';
import { HistoryEvent } from '../../stores/journalStore';
import { formatEventForDisplay } from './EventFormatter';

interface Props {
  events: HistoryEvent[];
  title?: string;
}

export const SessionTimeline: React.FC<Props> = ({ events, title = 'Timeline des Événements' }) => {
  const { t } = useTranslation('common');
  return (
    <div className="session-timeline">
      <h3>{title}</h3>

      {events.length === 0 ? (
        <div className="empty-state">
          <p>{t('timeline.empty')}</p>
        </div>
      ) : (
        <div className="timeline-vertical">
          {events.map((event, index) => {
            const { label, description } = formatEventForDisplay({
              eventType: event.eventType,
              eventData: event.eventData,
            });

            return (
              <div key={event.id} className="timeline-item">
                {/* Timeline connector */}
                <div className="timeline-connector">
                  <div className="timeline-dot"></div>
                  {index < events.length - 1 && <div className="timeline-line"></div>}
                </div>

                {/* Event content */}
                <div className="timeline-content">
                  <div className="timeline-header">
                    <span className="timeline-event-type">{label}</span>
                    <span className="timeline-time">
                      {event.timestamp.toLocaleString('fr-FR', {
                        day: '2-digit',
                        month: '2-digit',
                        year: 'numeric',
                        hour: '2-digit',
                        minute: '2-digit',
                      })}
                    </span>
                  </div>
                  {description && (
                    <div className="timeline-description">
                      {description}
                    </div>
                  )}
                </div>
              </div>
            );
          })}
        </div>
      )}
    </div>
  );
};
