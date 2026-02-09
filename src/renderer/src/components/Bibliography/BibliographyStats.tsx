import React, { useState, useEffect } from 'react';
import {
  BarChart3,
  Users,
  BookOpen,
  Calendar,
  TrendingUp,
  FileText,
  Award,
  PieChart,
  Tag
} from 'lucide-react';
import './BibliographyStats.css';

interface PublicationsByYear {
  year: string;
  count: number;
}

interface PublicationsByType {
  type: string;
  count: number;
  percentage: number;
}

interface AuthorStats {
  name: string;
  publicationCount: number;
  coauthors: string[];
  years: string[];
}

interface JournalStats {
  name: string;
  publicationCount: number;
  percentage: number;
}

interface TimelineData {
  year: string;
  cumulative: number;
  annual: number;
}

interface TagStats {
  tag: string;
  count: number;
  percentage: number;
}

interface BibliographyStatistics {
  totalCitations: number;
  totalAuthors: number;
  totalJournals: number;
  yearRange: { min: string; max: string };
  publicationsByYear: PublicationsByYear[];
  publicationsByType: PublicationsByType[];
  topAuthors: AuthorStats[];
  topJournals: JournalStats[];
  topTags: TagStats[];
  timelineData: TimelineData[];
  averageAuthorsPerPaper: number;
  citationsWithPDFs: number;
  pdfCoverage: number;
  citationsWithTags: number;
  tagCoverage: number;
}

interface BibliographyStatsProps {
  citations: any[];
  onClose?: () => void;
}

export const BibliographyStats: React.FC<BibliographyStatsProps> = ({ citations, onClose }) => {
  const [statistics, setStatistics] = useState<BibliographyStatistics | null>(null);
  const [loading, setLoading] = useState(true);
  const [activeTab, setActiveTab] = useState<'overview' | 'authors' | 'publications' | 'tags' | 'timeline'>('overview');

  useEffect(() => {
    loadStatistics();
  }, [citations]);

  const loadStatistics = async () => {
    setLoading(true);
    try {
      const result = await window.electron.bibliography.getStatistics(citations);
      if (result.success && result.statistics) {
        setStatistics(result.statistics);
      }
    } catch (error) {
      console.error('Failed to load statistics:', error);
    } finally {
      setLoading(false);
    }
  };

  if (loading) {
    return (
      <div className="bibliography-stats-loading">
        <div className="spinner"></div>
        <p>Analyzing bibliography...</p>
      </div>
    );
  }

  if (!statistics) {
    return (
      <div className="bibliography-stats-error">
        <p>Failed to load statistics</p>
      </div>
    );
  }

  return (
    <div className="bibliography-stats">
      <div className="stats-header">
        <h2>Bibliography Statistics</h2>
        {onClose && (
          <button className="close-button" onClick={onClose}>×</button>
        )}
      </div>

      {/* Tabs */}
      <div className="stats-tabs">
        <button
          className={`tab-button ${activeTab === 'overview' ? 'active' : ''}`}
          onClick={() => setActiveTab('overview')}
        >
          <BarChart3 size={16} />
          Overview
        </button>
        <button
          className={`tab-button ${activeTab === 'authors' ? 'active' : ''}`}
          onClick={() => setActiveTab('authors')}
        >
          <Users size={16} />
          Authors
        </button>
        <button
          className={`tab-button ${activeTab === 'publications' ? 'active' : ''}`}
          onClick={() => setActiveTab('publications')}
        >
          <BookOpen size={16} />
          Publications
        </button>
        <button
          className={`tab-button ${activeTab === 'tags' ? 'active' : ''}`}
          onClick={() => setActiveTab('tags')}
        >
          <Tag size={16} />
          Tags
        </button>
        <button
          className={`tab-button ${activeTab === 'timeline' ? 'active' : ''}`}
          onClick={() => setActiveTab('timeline')}
        >
          <TrendingUp size={16} />
          Timeline
        </button>
      </div>

      <div className="stats-content">
        {activeTab === 'overview' && (
          <OverviewTab statistics={statistics} />
        )}
        {activeTab === 'authors' && (
          <AuthorsTab statistics={statistics} />
        )}
        {activeTab === 'publications' && (
          <PublicationsTab statistics={statistics} />
        )}
        {activeTab === 'tags' && (
          <TagsTab statistics={statistics} />
        )}
        {activeTab === 'timeline' && (
          <TimelineTab statistics={statistics} />
        )}
      </div>
    </div>
  );
};

// Overview Tab Component
const OverviewTab: React.FC<{ statistics: BibliographyStatistics }> = ({ statistics }) => {
  return (
    <div className="overview-tab">
      <div className="stats-grid">
        <div className="stat-card primary">
          <div className="stat-icon">
            <FileText size={24} />
          </div>
          <div className="stat-info">
            <div className="stat-value">{statistics.totalCitations}</div>
            <div className="stat-label">Total Citations</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Users size={24} />
          </div>
          <div className="stat-info">
            <div className="stat-value">{statistics.totalAuthors}</div>
            <div className="stat-label">Unique Authors</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <BookOpen size={24} />
          </div>
          <div className="stat-info">
            <div className="stat-value">{statistics.totalJournals}</div>
            <div className="stat-label">Journals</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Calendar size={24} />
          </div>
          <div className="stat-info">
            <div className="stat-value">
              {statistics.yearRange.min} - {statistics.yearRange.max}
            </div>
            <div className="stat-label">Year Range</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <Users size={24} />
          </div>
          <div className="stat-info">
            <div className="stat-value">{statistics.averageAuthorsPerPaper}</div>
            <div className="stat-label">Avg Authors/Paper</div>
          </div>
        </div>

        <div className="stat-card">
          <div className="stat-icon">
            <FileText size={24} />
          </div>
          <div className="stat-info">
            <div className="stat-value">{statistics.pdfCoverage}%</div>
            <div className="stat-label">PDF Coverage</div>
            <div className="stat-subtitle">
              {statistics.citationsWithPDFs} / {statistics.totalCitations} with PDFs
            </div>
          </div>
        </div>
      </div>

      {/* Publications by Type */}
      <div className="chart-section">
        <h3><PieChart size={18} /> Publications by Type</h3>
        <div className="type-chart">
          {statistics.publicationsByType.map((type, idx) => (
            <div key={idx} className="type-item">
              <div className="type-bar-container">
                <div
                  className="type-bar"
                  style={{ width: `${type.percentage}%` }}
                />
              </div>
              <div className="type-info">
                <span className="type-name">{type.type}</span>
                <span className="type-count">{type.count} ({type.percentage}%)</span>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};

// Authors Tab Component
const AuthorsTab: React.FC<{ statistics: BibliographyStatistics }> = ({ statistics }) => {
  return (
    <div className="authors-tab">
      <div className="section-header">
        <h3><Award size={18} /> Top Authors</h3>
        <p className="section-subtitle">Most prolific authors in your bibliography</p>
      </div>

      <div className="authors-list">
        {statistics.topAuthors.slice(0, 15).map((author, idx) => (
          <div key={idx} className="author-card">
            <div className="author-rank">#{idx + 1}</div>
            <div className="author-info">
              <div className="author-name">{author.name}</div>
              <div className="author-meta">
                <span className="meta-item">
                  <FileText size={14} />
                  {author.publicationCount} publication{author.publicationCount > 1 ? 's' : ''}
                </span>
                <span className="meta-item">
                  <Users size={14} />
                  {author.coauthors.length} coauthor{author.coauthors.length !== 1 ? 's' : ''}
                </span>
                <span className="meta-item">
                  <Calendar size={14} />
                  {author.years.length > 1
                    ? `${author.years[0]} - ${author.years[author.years.length - 1]}`
                    : author.years[0]
                  }
                </span>
              </div>
            </div>
            <div className="author-bar">
              <div
                className="author-bar-fill"
                style={{
                  width: `${(author.publicationCount / statistics.topAuthors[0].publicationCount) * 100}%`
                }}
              />
            </div>
          </div>
        ))}
      </div>
    </div>
  );
};

// Publications Tab Component
const PublicationsTab: React.FC<{ statistics: BibliographyStatistics }> = ({ statistics }) => {
  return (
    <div className="publications-tab">
      {/* Top Journals */}
      <div className="section">
        <div className="section-header">
          <h3><BookOpen size={18} /> Top Journals</h3>
          <p className="section-subtitle">Most frequent publication venues</p>
        </div>
        <div className="journals-list">
          {statistics.topJournals.slice(0, 10).map((journal, idx) => (
            <div key={idx} className="journal-item">
              <div className="journal-rank">#{idx + 1}</div>
              <div className="journal-info">
                <div className="journal-name">{journal.name}</div>
                <div className="journal-stats">
                  {journal.publicationCount} publication{journal.publicationCount > 1 ? 's' : ''} ({journal.percentage}%)
                </div>
              </div>
              <div className="journal-bar">
                <div
                  className="journal-bar-fill"
                  style={{
                    width: `${(journal.publicationCount / statistics.topJournals[0].publicationCount) * 100}%`
                  }}
                />
              </div>
            </div>
          ))}
        </div>
      </div>

      {/* Publications by Year */}
      <div className="section">
        <div className="section-header">
          <h3><Calendar size={18} /> Publications by Year</h3>
        </div>
        <div className="year-chart">
          {statistics.publicationsByYear.map((year, idx) => {
            const maxCount = Math.max(...statistics.publicationsByYear.map(y => y.count));
            return (
              <div key={idx} className="year-item">
                <div className="year-label">{year.year}</div>
                <div className="year-bar-container">
                  <div
                    className="year-bar"
                    style={{ width: `${(year.count / maxCount) * 100}%` }}
                  />
                  <span className="year-count">{year.count}</span>
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// Tags Tab Component
const TagsTab: React.FC<{ statistics: BibliographyStatistics }> = ({ statistics }) => {
  if (!statistics.topTags || statistics.topTags.length === 0) {
    return (
      <div className="tags-tab">
        <div className="section-header">
          <h3><Tag size={18} /> No Tags Available</h3>
          <p className="section-subtitle">Add tags to your citations to see tag statistics</p>
        </div>
      </div>
    );
  }

  return (
    <div className="tags-tab">
      <div className="section-header">
        <h3><Tag size={18} /> Tag Statistics</h3>
        <p className="section-subtitle">Most frequently used tags in your bibliography</p>
      </div>

      {/* Tag Coverage Card */}
      <div className="stat-card primary" style={{ marginBottom: '1.5rem' }}>
        <div className="stat-icon">
          <Tag size={24} />
        </div>
        <div className="stat-info">
          <div className="stat-value">{statistics.tagCoverage}%</div>
          <div className="stat-label">Tag Coverage</div>
          <div className="stat-subtitle">
            {statistics.citationsWithTags} / {statistics.totalCitations} citations have tags
          </div>
        </div>
      </div>

      {/* Top Tags List */}
      <div className="section">
        <div className="tags-list">
          {statistics.topTags.map((tagStat, idx) => {
            const maxCount = statistics.topTags[0].count;
            return (
              <div key={idx} className="tag-stat-item">
                <div className="tag-stat-rank">#{idx + 1}</div>
                <div className="tag-stat-info">
                  <div className="tag-stat-name">
                    <Tag size={14} />
                    {tagStat.tag}
                  </div>
                  <div className="tag-stat-details">
                    {tagStat.count} citation{tagStat.count > 1 ? 's' : ''} ({tagStat.percentage}%)
                  </div>
                </div>
                <div className="tag-stat-bar">
                  <div
                    className="tag-stat-bar-fill"
                    style={{ width: `${(tagStat.count / maxCount) * 100}%` }}
                  />
                </div>
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
};

// Timeline Tab Component
const TimelineTab: React.FC<{ statistics: BibliographyStatistics }> = ({ statistics }) => {
  const maxCumulative = Math.max(...statistics.timelineData.map(d => d.cumulative));
  const maxAnnual = Math.max(...statistics.timelineData.map(d => d.annual));

  return (
    <div className="timeline-tab">
      <div className="section-header">
        <h3><TrendingUp size={18} /> Bibliography Growth Over Time</h3>
        <p className="section-subtitle">Cumulative and annual publication trends</p>
      </div>

      <div className="timeline-chart">
        <div className="chart-legend">
          <div className="legend-item">
            <span className="legend-color cumulative"></span>
            Cumulative
          </div>
          <div className="legend-item">
            <span className="legend-color annual"></span>
            Annual
          </div>
        </div>

        <div className="timeline-items">
          {statistics.timelineData.map((data, idx) => (
            <div key={idx} className="timeline-item">
              <div className="timeline-year">{data.year}</div>
              <div className="timeline-bars">
                <div className="bar-row">
                  <div className="bar-label">Cumulative</div>
                  <div className="bar-container">
                    <div
                      className="bar cumulative"
                      style={{ width: `${(data.cumulative / maxCumulative) * 100}%` }}
                    />
                    <span className="bar-value">{data.cumulative}</span>
                  </div>
                </div>
                <div className="bar-row">
                  <div className="bar-label">Annual</div>
                  <div className="bar-container">
                    <div
                      className="bar annual"
                      style={{ width: `${(data.annual / maxAnnual) * 100}%` }}
                    />
                    <span className="bar-value">{data.annual}</span>
                  </div>
                </div>
              </div>
            </div>
          ))}
        </div>
      </div>
    </div>
  );
};
