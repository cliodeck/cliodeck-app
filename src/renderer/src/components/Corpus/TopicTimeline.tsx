import React from 'react';
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

// Palette de couleurs pour les topics
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
  if (!timelineData || timelineData.length === 0) {
    return (
      <div className="timeline-empty">
        <p>Aucune donnée temporelle disponible. Les documents doivent avoir des métadonnées d'année.</p>
      </div>
    );
  }

  // Créer les labels des topics pour la légende
  const topicLabels = topics.reduce((acc, topic) => {
    const label = topic.keywords.slice(0, 3).join(' - ');
    acc[`topic_${topic.id}`] = `Topic ${topic.id}: ${label}`;
    return acc;
  }, {} as Record<string, string>);

  // Custom tooltip pour afficher les informations détaillées
  const CustomTooltip = ({ active, payload, label }: any) => {
    if (active && payload && payload.length) {
      return (
        <div
          style={{
            backgroundColor: 'rgba(0, 0, 0, 0.8)',
            color: 'white',
            padding: '10px',
            borderRadius: '5px',
            fontSize: '12px',
          }}
        >
          <p style={{ fontWeight: 'bold', marginBottom: '5px' }}>Année: {label}</p>
          {payload
            .sort((a: any, b: any) => b.value - a.value)
            .map((entry: any, index: number) => (
              <p key={index} style={{ color: entry.color, margin: '2px 0' }}>
                {topicLabels[entry.dataKey]}: {entry.value} doc(s)
              </p>
            ))}
        </div>
      );
    }
    return null;
  };

  // Extraire tous les topics présents dans les données
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
    <div className="topic-timeline" style={{ width: '100%', height: '400px' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart
          data={timelineData}
          margin={{ top: 10, right: 30, left: 0, bottom: 0 }}
          stackOffset="silhouette"
        >
          <CartesianGrid strokeDasharray="3 3" stroke="#444" />
          <XAxis dataKey="year" stroke="#ccc" />
          <YAxis stroke="#ccc" />
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
