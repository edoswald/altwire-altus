/**
 * analyze_coverage_gaps handler.
 * Analyzes how thoroughly AltWire has covered a specific artist or topic.
 */

import { searchAltwareArchive } from './altus-search.js';
import { synthesizeCoverageAssessment } from '../lib/synthesizer.js';
import { logger } from '../logger.js';

function buildOpportunities(coverageStatus, monthsSinceLastPost, hasWritten, hasPhoto) {
  const opportunities = [];

  if (coverageStatus === 'none') {
    opportunities.push('First coverage — any format would be new territory for AltWire');
  }
  if (coverageStatus === 'gallery_only') {
    opportunities.push('Photo coverage exists but no written piece — strong candidate for a first review or feature');
  }
  if (coverageStatus === 'written_only') {
    opportunities.push('Written coverage exists but no photo gallery — live coverage opportunity if touring');
  }
  if (monthsSinceLastPost !== null && monthsSinceLastPost > 18) {
    opportunities.push(`Last written piece was ${monthsSinceLastPost} months ago — overdue for a check-in`);
  }
  if (hasWritten && !opportunities.some(o => o.includes('review'))) {
    opportunities.push('Consider whether existing written coverage includes an album review');
  }

  return opportunities;
}

/**
 * @param {{ subject: string, limit: number }} params
 * @returns {Promise<object>}
 */
export async function analyzeCoverageGaps({ subject, limit }) {
  if (!process.env.DATABASE_URL) {
    return { error: 'Database not configured' };
  }

  // Use a fixed internal search depth so threshold analysis isn't starved by a small limit.
  // The user's limit controls output array sizes, not how many candidates are evaluated.
  const searchDepth = Math.max(limit, 20);
  const searchResult = await searchAltwareArchive({ query: subject, limit: searchDepth, content_type: 'all' });
  if (searchResult.error) {
    return { error: searchResult.error };
  }

  const allResults = searchResult.results;
  const postResults = allResults.filter(r => r.type === 'post');
  const galleryResults = allResults.filter(r => r.type === 'gallery');

  // Thresholds applied against weighted_score
  const directCoverage  = allResults.filter(r => r.weighted_score >= 0.50);
  const relatedCoverage = allResults.filter(r => r.weighted_score >= 0.35 && r.weighted_score < 0.50);
  const hasDirectPosts   = postResults.some(r => r.weighted_score >= 0.50);
  const hasDirectGallery = galleryResults.some(r => r.weighted_score >= 0.50);
  const topScore         = allResults[0]?.weighted_score ?? 0;

  let coverageStatus;
  if (topScore < 0.25) {
    coverageStatus = 'none';
  } else if (!hasDirectPosts && hasDirectGallery) {
    coverageStatus = 'gallery_only';
  } else if (hasDirectPosts && !hasDirectGallery) {
    coverageStatus = 'written_only';
  } else if (hasDirectPosts && hasDirectGallery) {
    coverageStatus = 'full';
  } else {
    coverageStatus = 'indirect';
  }

  const directPostDates = directCoverage
    .filter(r => r.type === 'post' && r.published_at)
    .map(r => new Date(r.published_at));
  const mostRecentPost = directPostDates.length
    ? new Date(Math.max(...directPostDates))
    : null;
  const monthsSinceLastPost = mostRecentPost
    ? Math.floor((Date.now() - mostRecentPost) / (1000 * 60 * 60 * 24 * 30))
    : null;

  const contextLines = [
    `Subject: ${subject}`,
    `Coverage status: ${coverageStatus}`,
    `Top weighted score: ${topScore.toFixed(3)}`,
    `Direct coverage items (weighted score >= 0.50): ${directCoverage.length}`,
    `Related coverage items (weighted score 0.35-0.49): ${relatedCoverage.length}`,
    `Most recent direct post: ${mostRecentPost ? mostRecentPost.toISOString().split('T')[0] : 'none'}`,
    '',
    'Direct coverage found:',
    ...directCoverage.map(r =>
      `- [${r.type}] "${r.title}" (${r.published_at?.split('T')[0] ?? 'no date'}) — score ${r.similarity.toFixed(3)}`
    ),
    '',
    'Related coverage found:',
    ...relatedCoverage.map(r =>
      `- [${r.type}] "${r.title}" (${r.published_at?.split('T')[0] ?? 'no date'}) — score ${r.similarity.toFixed(3)}`
    ),
  ].join('\n');

  const assessment = await synthesizeCoverageAssessment(subject, contextLines);

  logger.info('Coverage analysis complete', { subject, coverageStatus, topScore });

  return {
    subject,
    coverage_status: coverageStatus,
    top_similarity: topScore,
    direct_coverage_count: directCoverage.length,
    related_coverage_count: relatedCoverage.length,
    has_written_coverage: hasDirectPosts,
    has_photo_coverage: hasDirectGallery,
    months_since_last_post: monthsSinceLastPost,
    direct_coverage: directCoverage.map(r => ({
      type: r.type,
      title: r.title,
      url: r.url,
      published_at: r.published_at,
      similarity: r.similarity,
      weighted_score: r.weighted_score,
    })),
    related_coverage: relatedCoverage.map(r => ({
      type: r.type,
      title: r.title,
      url: r.url,
      published_at: r.published_at,
      similarity: r.similarity,
      weighted_score: r.weighted_score,
    })),
    assessment,
    editorial_opportunities: buildOpportunities(coverageStatus, monthsSinceLastPost, hasDirectPosts, hasDirectGallery),
  };
}
