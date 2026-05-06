import React from 'react';
import { useTranslation } from 'react-i18next';
import {
  AreaChart,
  Area,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';

interface TimelineData {
  year: number;
  [topicId: string]: number;
}

interface TopicInfo {
  id: number;
  keywords: string[];
}

interface TopicTimelineProps {
  timelineData: TimelineData[];
  topics: TopicInfo[];
}

// Data-visualization palette — intentionally hardcoded (not theme tokens)
const TOPIC_COLORS = [
  '#8884d8',
  '#82ca9d',
  '#ffc658',
  '#ff7c7c',
  '#a4de6c',
  '#d084d0',
  '#8dd1e1',
  '#ffb347',
  '#a28dd1',
  '#ff6b9d',
  '#c2c2f0',
  '#ffcc80',
  '#81c784',
  '#ff8a65',
  '#ba68c8',
];

const getTopicColor = (index: number) => {
  return TOPIC_COLORS[index % TOPIC_COLORS.length];
};

export const TopicTimeline: React.FC<TopicTimelineProps> = ({ timelineData, topics }) => {
  const { t } = useTranslation();

  if (!timelineData || timelineData.length === 0) {
    return (
      <div className="timeline-empty">
        <p>{t('corpus.noTimelineData')}</p>
      </div>
    );
  }

  const topicLabels = topics.reduce((acc, topic) => {
    const label = topic.keywords.slice(0, 3).join(' - ');
    acc[`topic_${topic.id}`] = `Topic ${topic.id}: ${label}`;
    return acc;
  }, {} as Record<string, string>);

  interface TooltipEntry { dataKey: string; value: number; color: string }
  const CustomTooltip = ({ active, payload, label }: { active?: boolean; payload?: TooltipEntry[]; label?: string }) => {
    if (active && payload && payload.length) {
      return (
        <div className="topic-timeline-tooltip">
          <p className="topic-timeline-tooltip-title">
            {t('corpus.timelineYear')}: {label}
          </p>
          {payload
            .sort((a, b) => b.value - a.value)
            .map((entry, index) => (
              <p key={index} style={{ color: entry.color }} className="topic-timeline-tooltip-entry">
                {topicLabels[entry.dataKey]}: {entry.value} {t('corpus.timelineDocCount')}
              </p>
            ))}
        </div>
      );
    }
    return null;
  };

  const topicKeys = new Set<string>();
  timelineData.forEach((data) => {
    Object.keys(data).forEach((key) => {
      if (key !== 'year') {
        topicKeys.add(key);
      }
    });
  });

  const sortedTopicKeys = Array.from(topicKeys).sort((a, b) => {
    const aNum = parseInt(a.replace('topic_', ''));
    const bNum = parseInt(b.replace('topic_', ''));
    return aNum - bNum;
  });

  return (
    <div className="topic-timeline">
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={timelineData}
          margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
          stackOffset="silhouette"
        >
          <CartesianGrid strokeDasharray="3 3" stroke="var(--border-color)" />
          <XAxis dataKey="year" stroke="var(--text-tertiary)" />
          <YAxis stroke="var(--text-tertiary)" />
          <Tooltip content={<CustomTooltip />} />
          <Legend
            wrapperStyle={{
              fontSize: '11px',
              maxHeight: '80px',
              overflowY: 'auto',
            }}
            formatter={(value) => topicLabels[value as string] || value}
          />
          {sortedTopicKeys.map((topicKey) => {
            const topicId = parseInt(topicKey.replace('topic_', ''));
            return (
              <Area
                key={topicKey}
                type="monotone"
                dataKey={topicKey}
                stackId="1"
                stroke={getTopicColor(topicId)}
                fill={getTopicColor(topicId)}
                fillOpacity={0.7}
              />
            );
          })}
        </AreaChart>
      </ResponsiveContainer>
    </div>
  );
};
