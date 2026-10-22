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
];
