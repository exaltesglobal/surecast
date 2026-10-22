// Database migrations, applied in order on start-up. Never edit a released migration:
// add a new entry at the end instead.
const T = 'ENGINE=InnoDB DEFAULT CHARSET=utf8mb4 COLLATE=utf8mb4_unicode_ci';

export const MIGRATIONS: string[][] = [
  [
    `CREATE TABLE users (
      id VARCHAR(24) PRIMARY KEY,
      email VARCHAR(190) NOT NULL UNIQUE,
      name VARCHAR(120) NOT NULL DEFAULT '',
      created_at DATETIME(3) NOT NULL
    ) ${T}`,
    `CREATE TABLE login_codes (
      email VARCHAR(190) PRIMARY KEY,
      code_hash CHAR(64) NOT NULL,
      expires_at DATETIME(3) NOT NULL,
      attempts INT NOT NULL DEFAULT 0
    ) ${T}`,
    `CREATE TABLE sessions (
      id VARCHAR(24) PRIMARY KEY,
      user_id VARCHAR(24) NOT NULL,
      token_hash CHAR(64) NOT NULL UNIQUE,
      expires_at DATETIME(3) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_sessions_user (user_id)
    ) ${T}`,
    `CREATE TABLE workspaces (
      id VARCHAR(24) PRIMARY KEY,
      name VARCHAR(120) NOT NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      alert_emails TEXT NULL,
      created_at DATETIME(3) NOT NULL
    ) ${T}`,
    `CREATE TABLE members (
      workspace_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      role VARCHAR(16) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (workspace_id, user_id),
      KEY idx_members_user (user_id)
    ) ${T}`,
    `CREATE TABLE clients (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      name VARCHAR(120) NOT NULL,
      timezone VARCHAR(64) NOT NULL DEFAULT 'UTC',
      color VARCHAR(9) NOT NULL DEFAULT '#FF7A1A',
      approval_required TINYINT(1) NOT NULL DEFAULT 0,
      share_token VARCHAR(48) NOT NULL UNIQUE,
      contact_email VARCHAR(190) NULL,
      archived_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_clients_ws (workspace_id)
    ) ${T}`,
    `CREATE TABLE channels (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      platform VARCHAR(24) NOT NULL,
      name VARCHAR(190) NOT NULL,
      handle VARCHAR(190) NOT NULL DEFAULT '',
      external_id VARCHAR(190) NOT NULL DEFAULT '',
      avatar_url VARCHAR(500) NULL,
      credentials TEXT NOT NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'ok',
      status_detail VARCHAR(500) NULL,
      token_expires_at DATETIME(3) NULL,
      last_checked_at DATETIME(3) NULL,
      last_ok_at DATETIME(3) NULL,
      consecutive_failures INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      KEY idx_channels_ws (workspace_id),
      KEY idx_channels_client (client_id)
    ) ${T}`,
    `CREATE TABLE media (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      public_key VARCHAR(48) NOT NULL UNIQUE,
      filename VARCHAR(190) NOT NULL,
      mime VARCHAR(64) NOT NULL,
      size INT NOT NULL,
      alt TEXT NULL,
      data LONGBLOB NOT NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_media_ws (workspace_id)
    ) ${T}`,
    `CREATE TABLE posts (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      author_id VARCHAR(24) NULL,
      status VARCHAR(24) NOT NULL,
      body TEXT NOT NULL,
      media_ids TEXT NOT NULL,
      scheduled_at DATETIME(3) NULL,
      approval_status VARCHAR(24) NOT NULL DEFAULT 'not_needed',
      source VARCHAR(16) NOT NULL DEFAULT 'app',
      created_at DATETIME(3) NOT NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_posts_ws_time (workspace_id, scheduled_at),
      KEY idx_posts_client_time (client_id, scheduled_at)
    ) ${T}`,
    `CREATE TABLE post_targets (
      id VARCHAR(24) PRIMARY KEY,
      post_id VARCHAR(24) NOT NULL,
      workspace_id VARCHAR(24) NOT NULL,
      channel_id VARCHAR(24) NOT NULL,
      body_override TEXT NULL,
      status VARCHAR(24) NOT NULL,
      due_at DATETIME(3) NULL,
      next_attempt_at DATETIME(3) NULL,
      attempts INT NOT NULL DEFAULT 0,
      lock_token VARCHAR(24) NULL,
      locked_until DATETIME(3) NULL,
      preflight_at DATETIME(3) NULL,
      preflight_ok TINYINT(1) NULL,
      preflight_message VARCHAR(500) NULL,
      remote_id VARCHAR(190) NULL,
      remote_url VARCHAR(500) NULL,
      published_at DATETIME(3) NULL,
      error_code VARCHAR(48) NULL,
      error_message VARCHAR(1000) NULL,
      error_hint VARCHAR(500) NULL,
      updated_at DATETIME(3) NOT NULL,
      KEY idx_targets_post (post_id),
      KEY idx_targets_due (status, next_attempt_at),
      KEY idx_targets_channel (channel_id)
    ) ${T}`,
    `CREATE TABLE attempts (
      id VARCHAR(24) PRIMARY KEY,
      target_id VARCHAR(24) NOT NULL,
      number INT NOT NULL,
      started_at DATETIME(3) NOT NULL,
      finished_at DATETIME(3) NULL,
      outcome VARCHAR(16) NOT NULL,
      error_code VARCHAR(48) NULL,
      http_status INT NULL,
      message VARCHAR(1000) NULL,
      KEY idx_attempts_target (target_id)
    ) ${T}`,
    `CREATE TABLE post_comments (
      id VARCHAR(24) PRIMARY KEY,
      post_id VARCHAR(24) NOT NULL,
      author_name VARCHAR(120) NOT NULL,
      from_client TINYINT(1) NOT NULL DEFAULT 0,
      kind VARCHAR(24) NOT NULL DEFAULT 'comment',
      body TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_comments_post (post_id)
    ) ${T}`,
    `CREATE TABLE alerts (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      dedupe_key VARCHAR(190) NOT NULL,
      kind VARCHAR(32) NOT NULL,
      severity VARCHAR(16) NOT NULL,
      title VARCHAR(300) NOT NULL,
      detail VARCHAR(1000) NULL,
      client_id VARCHAR(24) NULL,
      channel_id VARCHAR(24) NULL,
      post_id VARCHAR(24) NULL,
      target_id VARCHAR(24) NULL,
      created_at DATETIME(3) NOT NULL,
      emailed_at DATETIME(3) NULL,
      resolved_at DATETIME(3) NULL,
      UNIQUE KEY uq_alerts_dedupe (workspace_id, dedupe_key),
      KEY idx_alerts_open (workspace_id, resolved_at)
    ) ${T}`,
    `CREATE TABLE oauth_states (
      state VARCHAR(48) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      user_id VARCHAR(24) NOT NULL,
      platform VARCHAR(24) NOT NULL,
      data TEXT NULL,
      expires_at DATETIME(3) NOT NULL
    ) ${T}`,
    `CREATE TABLE oauth_apps (
      platform VARCHAR(24) NOT NULL,
      instance VARCHAR(190) NOT NULL,
      client_id VARCHAR(190) NOT NULL,
      client_secret VARCHAR(190) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      PRIMARY KEY (platform, instance)
    ) ${T}`,
    `CREATE TABLE pending_connections (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      platform VARCHAR(24) NOT NULL,
      candidates TEXT NOT NULL,
      expires_at DATETIME(3) NOT NULL
    ) ${T}`,
    `CREATE TABLE api_keys (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      name VARCHAR(120) NOT NULL,
      prefix VARCHAR(16) NOT NULL,
      key_hash CHAR(64) NOT NULL UNIQUE,
      created_by VARCHAR(24) NOT NULL,
      last_used_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_keys_ws (workspace_id)
    ) ${T}`,
    `CREATE TABLE webhooks (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      url VARCHAR(500) NOT NULL,
      secret VARCHAR(64) NOT NULL,
      created_at DATETIME(3) NOT NULL,
      last_status INT NULL,
      last_sent_at DATETIME(3) NULL,
      KEY idx_webhooks_ws (workspace_id)
    ) ${T}`,
    `CREATE TABLE scheduler_runs (
      id INT PRIMARY KEY,
      last_tick_at DATETIME(3) NOT NULL,
      last_source VARCHAR(16) NOT NULL
    ) ${T}`,
  ],
  [
    // Brand voice for each client, used by the AI assistant.
    `ALTER TABLE clients ADD COLUMN voice TEXT NULL`,
    `CREATE TABLE ai_usage (
      workspace_id VARCHAR(24) NOT NULL,
      day DATE NOT NULL,
      requests INT NOT NULL DEFAULT 0,
      input_tokens BIGINT NOT NULL DEFAULT 0,
      output_tokens BIGINT NOT NULL DEFAULT 0,
      PRIMARY KEY (workspace_id, day)
    ) ${T}`,
  ],
  [
    // Threads, first comments and evergreen recycling.
    `ALTER TABLE posts ADD COLUMN thread TEXT NULL, ADD COLUMN first_comment TEXT NULL, ADD COLUMN recycle_days INT NULL,
      ADD COLUMN recycle_left INT NOT NULL DEFAULT 0, ADD COLUMN recycled_from VARCHAR(24) NULL`,
    `ALTER TABLE post_targets ADD COLUMN followups_total INT NOT NULL DEFAULT 0, ADD COLUMN followups_done INT NOT NULL DEFAULT 0,
      ADD COLUMN followups_ids TEXT NULL, ADD COLUMN followups_next_at DATETIME(3) NULL, ADD COLUMN followups_attempts INT NOT NULL DEFAULT 0,
      ADD COLUMN followups_error VARCHAR(1000) NULL, ADD KEY idx_targets_followups (followups_next_at)`,
    // Weekly posting times for "Add to queue".
    `ALTER TABLE clients ADD COLUMN queue_slots TEXT NULL`,
    // Saved hashtag groups and text snippets.
    `CREATE TABLE snippets (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NULL,
      name VARCHAR(120) NOT NULL,
      body TEXT NOT NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_snippets_ws (workspace_id)
    ) ${T}`,
    // RSS and Atom feeds that turn new articles into posts.
    `CREATE TABLE feeds (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      url VARCHAR(1000) NOT NULL,
      title VARCHAR(255) NOT NULL DEFAULT '',
      channel_ids TEXT NOT NULL,
      template TEXT NOT NULL,
      mode VARCHAR(16) NOT NULL,
      active TINYINT NOT NULL DEFAULT 1,
      seen MEDIUMTEXT NULL,
      last_checked_at DATETIME(3) NULL,
      last_item_at DATETIME(3) NULL,
      last_error VARCHAR(1000) NULL,
      failures INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      KEY idx_feeds_ws (workspace_id),
      KEY idx_feeds_check (active, last_checked_at)
    ) ${T}`,
  ],
  [
    // Engagement numbers and link clicks per post-to-channel.
    `ALTER TABLE post_targets ADD COLUMN likes INT NULL, ADD COLUMN comments INT NULL, ADD COLUMN shares INT NULL, ADD COLUMN views INT NULL,
      ADD COLUMN clicks INT NOT NULL DEFAULT 0, ADD COLUMN metrics_at DATETIME(3) NULL, ADD KEY idx_targets_metrics (status, published_at)`,
    // Follower counts, one row per channel per day.
    `ALTER TABLE channels ADD COLUMN followers INT NULL, ADD COLUMN followers_at DATETIME(3) NULL`,
    `CREATE TABLE channel_stats (
      channel_id VARCHAR(24) NOT NULL,
      day DATE NOT NULL,
      followers INT NOT NULL,
      PRIMARY KEY (channel_id, day)
    ) ${T}`,
    // Short links. scope is the target (or bio page) the link belongs to, so retries reuse the same code.
    `CREATE TABLE links (
      code VARCHAR(16) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      post_id VARCHAR(24) NULL,
      target_id VARCHAR(24) NULL,
      scope VARCHAR(48) NOT NULL,
      platform VARCHAR(16) NULL,
      url VARCHAR(2000) NOT NULL,
      url_hash CHAR(64) NOT NULL,
      clicks INT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_links_scope (scope, url_hash),
      KEY idx_links_client (client_id)
    ) ${T}`,
    `CREATE TABLE link_clicks (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      code VARCHAR(16) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      clicked_at DATETIME(3) NOT NULL,
      referrer VARCHAR(255) NULL,
      KEY idx_clicks_client (client_id, clicked_at),
      KEY idx_clicks_code (code)
    ) ${T}`,
    // Link tracking and UTM settings per client.
    `ALTER TABLE clients ADD COLUMN link_settings TEXT NULL`,
    // Link-in-bio pages.
    `CREATE TABLE bio_pages (
      client_id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      slug VARCHAR(64) NOT NULL,
      title VARCHAR(120) NOT NULL,
      bio VARCHAR(500) NOT NULL DEFAULT '',
      links TEXT NOT NULL,
      show_posts TINYINT NOT NULL DEFAULT 1,
      accent VARCHAR(16) NOT NULL DEFAULT '#FF7A1A',
      published TINYINT NOT NULL DEFAULT 1,
      updated_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_bio_slug (slug)
    ) ${T}`,
  ],
  [
    // The unified inbox: comments and replies from other people under published posts.
    `ALTER TABLE post_targets ADD COLUMN inbox_checked_at DATETIME(3) NULL`,
    `CREATE TABLE inbox_items (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NOT NULL,
      channel_id VARCHAR(24) NOT NULL,
      target_id VARCHAR(24) NOT NULL,
      post_id VARCHAR(24) NOT NULL,
      platform VARCHAR(16) NOT NULL,
      remote_id VARCHAR(190) NOT NULL,
      parent_remote_id VARCHAR(190) NOT NULL,
      root_remote_id VARCHAR(190) NOT NULL,
      author_name VARCHAR(190) NOT NULL,
      author_handle VARCHAR(190) NOT NULL DEFAULT '',
      author_avatar VARCHAR(500) NULL,
      body TEXT NOT NULL,
      url VARCHAR(500) NULL,
      received_at DATETIME(3) NOT NULL,
      status VARCHAR(12) NOT NULL DEFAULT 'open',
      reply_text TEXT NULL,
      reply_remote_id VARCHAR(190) NULL,
      replied_at DATETIME(3) NULL,
      replied_by VARCHAR(24) NULL,
      reply_error VARCHAR(1000) NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_inbox_remote (channel_id, remote_id),
      KEY idx_inbox_ws (workspace_id, status, received_at),
      KEY idx_inbox_client (client_id, status)
    ) ${T}`,
  ],
  [
    // Plans and staff controls on each workspace.
    `ALTER TABLE workspaces ADD COLUMN plan VARCHAR(16) NOT NULL DEFAULT 'trial', ADD COLUMN trial_ends_at DATETIME(3) NULL,
      ADD COLUMN suspended_at DATETIME(3) NULL, ADD COLUMN suspended_reason VARCHAR(500) NULL, ADD COLUMN staff_notes TEXT NULL`,
    `UPDATE workspaces SET trial_ends_at = DATE_ADD(created_at, INTERVAL 14 DAY) WHERE trial_ends_at IS NULL`,
    // A session a Surecast staff member opened to see a workspace as its owner does.
    `ALTER TABLE sessions ADD COLUMN impersonated_by VARCHAR(24) NULL`,
    // The Surecast team. People listed in ADMIN_EMAILS are always superadmins.
    `CREATE TABLE staff (
      user_id VARCHAR(24) PRIMARY KEY,
      role VARCHAR(16) NOT NULL,
      added_by VARCHAR(24) NULL,
      created_at DATETIME(3) NOT NULL
    ) ${T}`,
    `CREATE TABLE audit_log (
      id BIGINT AUTO_INCREMENT PRIMARY KEY,
      actor_id VARCHAR(24) NULL,
      actor_email VARCHAR(190) NOT NULL,
      action VARCHAR(48) NOT NULL,
      workspace_id VARCHAR(24) NULL,
      target VARCHAR(190) NULL,
      detail TEXT NULL,
      ip VARCHAR(64) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_audit_time (created_at),
      KEY idx_audit_ws (workspace_id, created_at)
    ) ${T}`,
    // Banners the Surecast team shows inside the app.
    `CREATE TABLE announcements (
      id VARCHAR(24) PRIMARY KEY,
      title VARCHAR(200) NOT NULL,
      body VARCHAR(1000) NOT NULL DEFAULT '',
      level VARCHAR(12) NOT NULL DEFAULT 'info',
      starts_at DATETIME(3) NOT NULL,
      ends_at DATETIME(3) NULL,
      created_by VARCHAR(24) NULL,
      created_at DATETIME(3) NOT NULL,
      KEY idx_announcements_time (starts_at, ends_at)
    ) ${T}`,
    // Connections to other apps. Chitthi (WhatsApp) for now: one for the agency (approvals and
    // alerts on WhatsApp) and one per client (their WhatsApp chats in the inbox).
    `CREATE TABLE integrations (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NULL,
      kind VARCHAR(16) NOT NULL,
      base_url VARCHAR(255) NOT NULL,
      credentials TEXT NOT NULL,
      settings TEXT NULL,
      account_name VARCHAR(190) NULL,
      hook_id VARCHAR(64) NULL,
      hook_token VARCHAR(64) NULL,
      status VARCHAR(16) NOT NULL DEFAULT 'ok',
      last_error VARCHAR(1000) NULL,
      last_used_at DATETIME(3) NULL,
      created_at DATETIME(3) NOT NULL,
      UNIQUE KEY uq_integrations_scope (workspace_id, kind, client_id),
      UNIQUE KEY uq_integrations_hook (hook_token)
    ) ${T}`,
    // The agency's own dates (launches, anniversaries) next to the built-in calendar of moments.
    `CREATE TABLE moments (
      id VARCHAR(24) PRIMARY KEY,
      workspace_id VARCHAR(24) NOT NULL,
      client_id VARCHAR(24) NULL,
      day DATE NOT NULL,
      name VARCHAR(160) NOT NULL,
      note VARCHAR(500) NOT NULL DEFAULT '',
      yearly TINYINT NOT NULL DEFAULT 0,
      created_at DATETIME(3) NOT NULL,
      KEY idx_moments_ws (workspace_id, day)
    ) ${T}`,
    // Emergency brake, brand safety guard, WhatsApp number and the weekly digest, per client.
    `ALTER TABLE clients ADD COLUMN paused_at DATETIME(3) NULL, ADD COLUMN paused_until DATETIME(3) NULL, ADD COLUMN paused_reason VARCHAR(500) NULL,
      ADD COLUMN paused_by VARCHAR(24) NULL, ADD COLUMN paused_missed VARCHAR(12) NULL, ADD COLUMN guard TEXT NULL, ADD COLUMN whatsapp_phone VARCHAR(32) NULL,
      ADD COLUMN digest_enabled TINYINT NOT NULL DEFAULT 0, ADD COLUMN digest_sent_at DATETIME(3) NULL`,
    // Alerts also go to WhatsApp when the agency connects Chitthi.
    `ALTER TABLE alerts ADD COLUMN whatsapp_at DATETIME(3) NULL`,
    // WhatsApp chats in the inbox have no post behind them.
    `ALTER TABLE inbox_items MODIFY target_id VARCHAR(24) NULL, MODIFY post_id VARCHAR(24) NULL`,
  ],
];
