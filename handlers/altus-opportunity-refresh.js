import { getStoryOpportunities } from './altus-topic-discovery.js';
import { getNewsOpportunities } from './altus-news-monitor.js';
import {
  upsertStoryOpportunityQueue,
  upsertNewsOpportunityQueue,
} from './altus-opportunity-queue.js';

export async function refreshOpportunityQueue({ days = 28, includeNews = true } = {}) {
  const warnings = [];
  const storyResult = await getStoryOpportunities({ days });
  let story = { upserted: 0 };
  let news = { upserted: 0, matches: 0, queries: 0 };

  if (storyResult?.error) {
    warnings.push({ source: 'story', error: storyResult.error, message: storyResult.message ?? null });
  } else {
    const queueResult = await upsertStoryOpportunityQueue(storyResult);
    if (queueResult?.error) {
      warnings.push({ source: 'story_queue', error: queueResult.error });
    } else {
      story = { upserted: queueResult?.upserted ?? 0 };
    }
  }

  if (includeNews) {
    const newsResult = await getNewsOpportunities({ days: 7 });
    if (newsResult?.error) {
      warnings.push({ source: 'news', error: newsResult.error, message: newsResult.message ?? null });
    } else {
      const newsQueueResult = await upsertNewsOpportunityQueue(newsResult);
      if (newsQueueResult?.error) {
        warnings.push({ source: 'news_queue', error: newsQueueResult.error });
      } else {
        news = {
          upserted: newsQueueResult?.upserted ?? 0,
          matches: newsResult?.watch_list_matches?.length ?? 0,
          queries: newsResult?.news_queries?.length ?? 0,
        };
      }
    }
  }

  return {
    success: warnings.length === 0,
    story,
    news,
    warnings,
  };
}
