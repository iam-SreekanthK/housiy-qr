-- =========================================================
-- Online Housiy Platform - Database Schema (MySQL 8)
-- Single consolidated schema file. Run this once against a
-- fresh database. There are no separate migration files to
-- apply — everything the app needs lives here.
-- =========================================================
SET NAMES utf8mb4;
SET FOREIGN_KEY_CHECKS = 0;

-- NOTE: no CREATE DATABASE / USE here on purpose. The MySQL image creates
-- $MYSQL_DATABASE (housiy_dev / housiy_uat / housiy_prod, ...) and runs this
-- file against it, so each environment gets its own schema. For a manual
-- install run:  mysql <your_database> < sql/schema.sql

-- ---------------------------------------------------------
-- users  (name + email based, no password auth)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS users (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    uuid            CHAR(36) NOT NULL UNIQUE,
    name            VARCHAR(120) NOT NULL,
    email           VARCHAR(190) NOT NULL,
    session_token   CHAR(64) NOT NULL,
    last_seen_at    DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_users_email (email),
    KEY idx_users_session_token (session_token)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- admin_users  (super admin - username/password)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS admin_users (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    username        VARCHAR(80) NOT NULL UNIQUE,
    password_hash   VARCHAR(255) NOT NULL,
    display_name    VARCHAR(120) NOT NULL,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    last_login_at   DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- rooms
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS rooms (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_code       CHAR(8) NOT NULL UNIQUE,          -- human shareable Room ID
    room_uuid       CHAR(36) NOT NULL UNIQUE,
    host_user_id    BIGINT UNSIGNED NOT NULL,
    title           VARCHAR(150) NOT NULL DEFAULT 'Housiy Room',
    max_players     SMALLINT UNSIGNED NOT NULL DEFAULT 100,
    status          ENUM('LOBBY','LIVE','PAUSED','COMPLETED','CANCELLED') NOT NULL DEFAULT 'LOBBY',
    prizes_enabled  JSON NOT NULL, -- e.g. ["FIRST_FIVE","TOP_ROW","MIDDLE_ROW","BOTTOM_ROW","FULL_HOUSE"]
    auto_call_enabled TINYINT(1) NOT NULL DEFAULT 0, -- host opted in to automatic number calling
    auto_call_interval_seconds SMALLINT UNSIGNED NULL DEFAULT NULL, -- seconds between automatic calls, when enabled
    rematch_room_code CHAR(8) NULL DEFAULT NULL, -- set once the host starts a rematch from this room
    parent_room_id  BIGINT UNSIGNED NULL DEFAULT NULL, -- points back to the room this one was rematched from
    is_archived     TINYINT(1) NOT NULL DEFAULT 0,
    started_at      DATETIME NULL,
    ended_at        DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    CONSTRAINT fk_rooms_host FOREIGN KEY (host_user_id) REFERENCES users(id) ON DELETE RESTRICT,
    CONSTRAINT fk_rooms_parent FOREIGN KEY (parent_room_id) REFERENCES rooms(id) ON DELETE SET NULL,
    KEY idx_rooms_status (status),
    KEY idx_rooms_host (host_user_id)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- room_players  (membership of a user in a room)
--
-- Joining is only permitted by the API while a room is in LOBBY
-- status (see src/api/room_join.php + GameEngine::start, which
-- flips the room to LIVE and locks out any further joins other
-- than reconnects for users who are already members). This table
-- itself does not need a status-aware constraint because the
-- application enforces "no new joins after start" transactionally
-- before ever inserting a row here.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_players (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id         BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    joined_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    is_active       TINYINT(1) NOT NULL DEFAULT 1,
    UNIQUE KEY uq_room_user (room_id, user_id),
    KEY idx_room_players_active_joined (room_id, is_active, joined_at, user_id),
    CONSTRAINT fk_rp_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_rp_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- rematch_declines: durable opt-out decisions for a completed room.
-- Historical room membership and game results remain intact.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_rematch_declines (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id BIGINT UNSIGNED NOT NULL,
    user_id BIGINT UNSIGNED NOT NULL,
    rematch_room_code CHAR(8) NOT NULL,
    declined_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_room_rematch_decline (room_id, user_id, rematch_room_code),
    KEY idx_rematch_decline_user (user_id, declined_at),
    CONSTRAINT fk_rrd_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_rrd_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- games (1:1 with a room's play session; kept separate from room
-- so a room's lifecycle/history stays independent of engine state)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS games (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id         BIGINT UNSIGNED NOT NULL,
    status          ENUM('NOT_STARTED','RUNNING','PAUSED','ENDED') NOT NULL DEFAULT 'NOT_STARTED',
    current_number  TINYINT UNSIGNED NULL,
    numbers_called_count SMALLINT UNSIGNED NOT NULL DEFAULT 0,
    started_at      DATETIME NULL,
    ended_at        DATETIME NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_games_room (room_id),
    CONSTRAINT fk_games_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- tickets (one unique ticket per player per room)
-- 3 rows x 9 cols, 15 numbers total, stored as JSON grid.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS tickets (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id         BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    ticket_grid     JSON NOT NULL,   -- 3x9 grid, 0 = blank cell
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ticket_room_user (room_id, user_id),
    CONSTRAINT fk_tickets_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_tickets_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- called_numbers (append-only ledger of numbers called per game)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS called_numbers (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    game_id         BIGINT UNSIGNED NOT NULL,
    number          TINYINT UNSIGNED NOT NULL,
    sequence_no     SMALLINT UNSIGNED NOT NULL,
    called_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_game_number (game_id, number),
    UNIQUE KEY uq_game_sequence (game_id, sequence_no),
    CONSTRAINT fk_cn_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- marked_numbers (player's own marks on their ticket - client
-- reported, used only for UX convenience, NOT for claim validation)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS marked_numbers (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    ticket_id       BIGINT UNSIGNED NOT NULL,
    number          TINYINT UNSIGNED NOT NULL,
    marked_at       DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_ticket_number (ticket_id, number),
    CONSTRAINT fk_mn_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- winner_claims (every claim attempt, valid or invalid, audited)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS winner_claims (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id         BIGINT UNSIGNED NOT NULL,
    game_id         BIGINT UNSIGNED NOT NULL,
    ticket_id       BIGINT UNSIGNED NOT NULL,
    user_id         BIGINT UNSIGNED NOT NULL,
    prize_type      ENUM('FIRST_FIVE','TOP_ROW','MIDDLE_ROW','BOTTOM_ROW','FULL_HOUSE') NOT NULL,
    is_valid        TINYINT(1) NOT NULL,
    reason          VARCHAR(255) NULL,
    claimed_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_wc_room_prize (room_id, prize_type),
    CONSTRAINT fk_wc_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_wc_game FOREIGN KEY (game_id) REFERENCES games(id) ON DELETE CASCADE,
    CONSTRAINT fk_wc_ticket FOREIGN KEY (ticket_id) REFERENCES tickets(id) ON DELETE CASCADE,
    CONSTRAINT fk_wc_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- A prize can only be won once per room -> partial unique index via
-- generated column trick: enforce "first valid claim wins" in application
-- layer (MySQL doesn't support partial unique indexes), but keep a
-- lookup table of awarded prizes for fast checks & DB-level integrity.
CREATE TABLE IF NOT EXISTS room_prize_winners (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id         BIGINT UNSIGNED NOT NULL,
    prize_type      ENUM('FIRST_FIVE','TOP_ROW','MIDDLE_ROW','BOTTOM_ROW','FULL_HOUSE') NOT NULL,
    winner_claim_id BIGINT UNSIGNED NOT NULL,
    awarded_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    UNIQUE KEY uq_room_prize (room_id, prize_type),
    CONSTRAINT fk_rpw_room FOREIGN KEY (room_id) REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_rpw_claim FOREIGN KEY (winner_claim_id) REFERENCES winner_claims(id) ON DELETE CASCADE
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- game_logs (audit trail: every state transition / admin action)
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS game_logs (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    room_id         BIGINT UNSIGNED NULL,
    game_id         BIGINT UNSIGNED NULL,
    actor_type      ENUM('SUPER_ADMIN','HOST','PLAYER','SYSTEM') NOT NULL,
    actor_user_id   BIGINT UNSIGNED NULL,
    action          VARCHAR(80) NOT NULL,
    details         JSON NULL,
    created_at      DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_logs_room (room_id),
    KEY idx_logs_action (action)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- rate_limit_attempts   [DEPRECATED - no longer written or read]
-- Rate limiting now lives in Redis (atomic Lua counters, see
-- src/includes/RateLimiter.php). The table is kept only so existing
-- databases and old tooling keep working; it can be dropped once no
-- deployed version references it.
-- (Original description:) Generic abuse-throttling ledger shared by every rate-limited flow
-- in the app.
-- `bucket` names the flow being throttled (e.g. "admin_login",
-- "identify"); `identifier` is whatever key that flow throttles on
-- (typically client IP). Rows older than the lookback window are
-- irrelevant and may be purged periodically by an ops cron job:
--   DELETE FROM rate_limit_attempts WHERE attempted_at < NOW() - INTERVAL 1 DAY;
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS rate_limit_attempts (
    id              BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    bucket          VARCHAR(40) NOT NULL,
    identifier      VARCHAR(190) NOT NULL,
    attempted_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_rla_lookup (bucket, identifier, attempted_at)
) ENGINE=InnoDB;

-- ---------------------------------------------------------
-- room_emoji_reactions
-- Emoji reactions sent inside a room. audience EVERYONE is visible to
-- every member of the room; audience PLAYER only to its sender and its
-- recipient. Rows older than a day are purged opportunistically by
-- src/api/reactions.php (Reactions::maybePurge). Existing databases that
-- predate this table get it created on first use (Reactions::guard), and
-- the statement is identical to Reactions::DDL in src/includes/Reactions.php.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_emoji_reactions (
    id                BIGINT UNSIGNED NOT NULL AUTO_INCREMENT PRIMARY KEY,
    room_id           BIGINT UNSIGNED NOT NULL,
    sender_user_id    BIGINT UNSIGNED NOT NULL,
    recipient_user_id BIGINT UNSIGNED NULL,
    audience          ENUM('EVERYONE','PLAYER') NOT NULL,
    emoji             VARCHAR(32) NOT NULL,
    created_at        TIMESTAMP NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_room_reactions (room_id, id),
    KEY idx_recipient_reactions (room_id, recipient_user_id, id),
    KEY idx_reactions_created (created_at),
    CONSTRAINT fk_rer_room      FOREIGN KEY (room_id)           REFERENCES rooms(id) ON DELETE CASCADE,
    CONSTRAINT fk_rer_sender    FOREIGN KEY (sender_user_id)    REFERENCES users(id) ON DELETE CASCADE,
    CONSTRAINT fk_rer_recipient FOREIGN KEY (recipient_user_id) REFERENCES users(id) ON DELETE CASCADE
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;


-- ---------------------------------------------------------
-- room_reaction_idempotency
-- Deduplicates retries of the same reaction across WebSocket and HTTP.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_reaction_idempotency (
    room_id BIGINT UNSIGNED NOT NULL,
    sender_user_id BIGINT UNSIGNED NOT NULL,
    idempotency_key CHAR(32) NOT NULL,
    reaction_id BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    PRIMARY KEY (room_id, sender_user_id, idempotency_key),
    KEY idx_reaction_idempotency_created (created_at)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

-- ---------------------------------------------------------
-- room_reaction_outbox
-- Durable transactional outbox for reaction realtime delivery. A reaction
-- and its outbox event are committed in the same MySQL transaction. Redis
-- Pub/Sub is best-effort; the worker retries unpublished rows after outages.
-- ---------------------------------------------------------
CREATE TABLE IF NOT EXISTS room_reaction_outbox (
    reaction_id       BIGINT UNSIGNED NOT NULL PRIMARY KEY,
    room_code         CHAR(8) NOT NULL,
    audience          ENUM('EVERYONE','PLAYER') NOT NULL,
    sender_user_id    BIGINT UNSIGNED NOT NULL,
    recipient_user_id BIGINT UNSIGNED NULL,
    payload            JSON NOT NULL,
    attempts           INT UNSIGNED NOT NULL DEFAULT 0,
    next_attempt_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    published_at       DATETIME NULL,
    last_error         VARCHAR(500) NULL,
    created_at         DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    KEY idx_reaction_outbox_pending (published_at, next_attempt_at, reaction_id)
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;

SET FOREIGN_KEY_CHECKS = 1;

-- ---------------------------------------------------------
-- seed a default super admin: username "superadmin" / password "admin#123"
-- Bcrypt hash below is valid and verifiable with PHP's password_verify().
-- CHANGE THIS PASSWORD IMMEDIATELY AFTER FIRST LOGIN (see Admin Guide) —
-- e.g. UPDATE admin_users SET password_hash = ? WHERE username = 'superadmin';
-- with a hash from password_hash($newPassword, PASSWORD_BCRYPT).
-- ---------------------------------------------------------
INSERT INTO admin_users (username, password_hash, display_name)
VALUES ('superadmin', '$2b$10$TOdJtdn1hw3qyfB19y6RmOysxUib/HHSXc0X6z0/KPjTXlCU/A9be', 'Super Admin')
ON DUPLICATE KEY UPDATE username = username;


-- Super-admin user block list. Normalized identity matching prevents blocked
-- users from re-registering with the same email/name.
CREATE TABLE IF NOT EXISTS user_blocks (
    id BIGINT UNSIGNED AUTO_INCREMENT PRIMARY KEY,
    user_id BIGINT UNSIGNED NULL,
    email_normalized VARCHAR(190) NULL,
    name_normalized VARCHAR(120) NULL,
    reason VARCHAR(500) NULL,
    blocked_by BIGINT UNSIGNED NULL,
    created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
    updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP,
    UNIQUE KEY uq_user_blocks_user (user_id),
    KEY idx_user_blocks_email (email_normalized),
    KEY idx_user_blocks_name (name_normalized),
    CONSTRAINT fk_user_blocks_user FOREIGN KEY (user_id) REFERENCES users(id) ON DELETE SET NULL,
    CONSTRAINT fk_user_blocks_admin FOREIGN KEY (blocked_by) REFERENCES admin_users(id) ON DELETE SET NULL
) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
