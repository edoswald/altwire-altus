/**
 * Altus Writer Tool Labels
 *
 * Maps MCP tool names to human-readable labels displayed in the
 * ToolCallBlock component while tools are executing.
 */

export const LABEL_MAP = {
  create_article_assignment: 'Creating article assignment',
  generate_article_outline: 'Generating article outline',
  approve_outline: 'Submitting outline approval',
  generate_article_draft: 'Generating article draft',
  fact_check_draft: 'Fact-checking draft',
  post_to_wordpress: 'Publishing to WordPress',
  get_draft_as_html: 'Exporting draft as HTML',
  get_story_opportunities: 'Checking story opportunities',
  get_news_opportunities: 'Checking news opportunities',
  log_editorial_decision: 'Logging editorial decision',
  get_article_assignment: 'Fetching assignment details',
  list_article_assignments: 'Listing assignments',

  // Monitoring & Digest
  get_altwire_uptime: 'Checking site uptime',
  get_altwire_incidents: 'Checking open incidents',
  get_altwire_morning_digest: 'Generating morning digest',

  // Chart generation
  generate_chart: 'Rendering chart',

  // Slack status
  post_slack_status: 'Posting to Slack',
  get_slack_post_history: 'Fetching Slack history',

  // Slack extended capabilities
  add_slack_reaction: 'Adding reaction',
  list_slack_reactions: 'Reading reactions',
  get_slack_dnd_status: 'Checking DND status',
  upload_slack_file: 'Uploading file to Slack',
  list_slack_channel_files: 'Listing Slack files',
  share_slack_file_public: 'Sharing file publicly',
  send_slack_dm: 'Sending DM',
  open_slack_dm: 'Opening DM',
  search_slack_messages: 'Searching Slack messages',
  schedule_slack_message: 'Scheduling Slack message',

  // Agent memory
  hal_read_memory: 'Reading memory',
  hal_write_memory: 'Writing memory',
  hal_list_memory: 'Listing memory',
};
