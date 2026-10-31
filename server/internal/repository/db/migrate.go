package db

import (
	"context"
	"database/sql"
	"fmt"
)

// migrations are applied in order; never edit a step that has shipped, append a new one instead.
var migrations = [][]string{
	{
		`CREATE TABLE users (
			id         TEXT PRIMARY KEY,
			name       TEXT NOT NULL UNIQUE,
			last_seq   INTEGER NOT NULL DEFAULT 0,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE blobs (
			hash       TEXT PRIMARY KEY,
			size       INTEGER NOT NULL,
			created_at TEXT NOT NULL
		)`,
		`CREATE TABLE gallery (
			user_id      TEXT NOT NULL REFERENCES users(id),
			id           TEXT NOT NULL,
			seq          INTEGER NOT NULL,
			status       TEXT NOT NULL CHECK (status IN ('partial', 'complete', 'purged')),
			photo_hash   TEXT NOT NULL,
			thumb_hash   TEXT NOT NULL,
			has_original INTEGER NOT NULL DEFAULT 0,
			has_thumb    INTEGER NOT NULL DEFAULT 0,
			updated_at   TEXT NOT NULL,
			taken_at     TEXT NOT NULL,
			deleted      INTEGER NOT NULL,
			purged_at    TEXT,
			data         TEXT NOT NULL,
			received_at  TEXT NOT NULL,
			PRIMARY KEY (user_id, id),
			UNIQUE (user_id, seq)
		)`,
		`CREATE INDEX gallery_status ON gallery(user_id, status, seq)`,
		`CREATE INDEX gallery_photo ON gallery(photo_hash)`,
		`CREATE INDEX gallery_thumb ON gallery(thumb_hash)`,
	},
}

func (d *DB) migrate(ctx context.Context) error {
	if _, err := d.sql.ExecContext(ctx, `CREATE TABLE IF NOT EXISTS schema_version (version INTEGER NOT NULL)`); err != nil {
		return fmt.Errorf("create schema_version: %w", err)
	}
	return d.WithTx(ctx, func(ctx context.Context) error {
		tx := d.q(ctx)
		var version sql.NullInt64
		if err := tx.QueryRowContext(ctx, `SELECT MAX(version) FROM schema_version`).Scan(&version); err != nil {
			return fmt.Errorf("read schema version: %w", err)
		}
		if int(version.Int64) > len(migrations) {
			return fmt.Errorf("database schema version %d is newer than this server (%d)", version.Int64, len(migrations))
		}
		for i := int(version.Int64); i < len(migrations); i++ {
			for _, stmt := range migrations[i] {
				if _, err := tx.ExecContext(ctx, stmt); err != nil {
					return fmt.Errorf("migration %d: %w", i+1, err)
				}
			}
			if _, err := tx.ExecContext(ctx, `DELETE FROM schema_version`); err != nil {
				return fmt.Errorf("migration %d: %w", i+1, err)
			}
			if _, err := tx.ExecContext(ctx, `INSERT INTO schema_version (version) VALUES (?)`, i+1); err != nil {
				return fmt.Errorf("migration %d: %w", i+1, err)
			}
		}
		return nil
	})
}
