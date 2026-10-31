// Package db stores users, gallery rows and the blob index in SQLite.
package db

import (
	"context"
	"database/sql"
	"errors"
	"fmt"
	"net/url"
	"os"

	_ "modernc.org/sqlite"

	"vibe-memory/internal/models"
)

// DB is the SQLite repository. Methods run inside the transaction carried by ctx, if any (see WithTx).
type DB struct {
	sql *sql.DB
}

type txKey struct{}

type querier interface {
	ExecContext(ctx context.Context, query string, args ...any) (sql.Result, error)
	QueryContext(ctx context.Context, query string, args ...any) (*sql.Rows, error)
	QueryRowContext(ctx context.Context, query string, args ...any) *sql.Row
}

// Open opens (creating if needed) the database file and applies migrations.
func Open(ctx context.Context, path string) (*DB, error) {
	// Create the file up front so that it gets 0600; SQLite copies these permissions to -wal and -shm.
	f, err := os.OpenFile(path, os.O_RDWR|os.O_CREATE, 0o600)
	if err != nil {
		return nil, fmt.Errorf("create database file: %w", err)
	}
	f.Close()

	q := url.Values{}
	q.Add("_pragma", "busy_timeout(5000)")
	q.Add("_pragma", "journal_mode(WAL)")
	q.Add("_pragma", "synchronous(FULL)")
	q.Add("_pragma", "foreign_keys(ON)")
	q.Set("_txlock", "immediate")
	sqlDB, err := sql.Open("sqlite", "file:"+path+"?"+q.Encode())
	if err != nil {
		return nil, fmt.Errorf("open database: %w", err)
	}
	d := &DB{sql: sqlDB}
	if err := d.migrate(ctx); err != nil {
		sqlDB.Close()
		return nil, err
	}
	return d, nil
}

// Close closes the database.
func (d *DB) Close() error { return d.sql.Close() }

func (d *DB) q(ctx context.Context) querier {
	if tx, ok := ctx.Value(txKey{}).(*sql.Tx); ok {
		return tx
	}
	return d.sql
}

// WithTx runs fn in one write transaction. Repository calls made with the ctx passed to fn join it.
// A nested call reuses the outer transaction.
func (d *DB) WithTx(ctx context.Context, fn func(ctx context.Context) error) error {
	if _, ok := ctx.Value(txKey{}).(*sql.Tx); ok {
		return fn(ctx)
	}
	tx, err := d.sql.BeginTx(ctx, nil)
	if err != nil {
		return fmt.Errorf("begin: %w", err)
	}
	if err := fn(context.WithValue(ctx, txKey{}, tx)); err != nil {
		tx.Rollback()
		return err
	}
	if err := tx.Commit(); err != nil {
		return fmt.Errorf("commit: %w", err)
	}
	return nil
}

// CreateUser adds an account. The id is also the account's bearer token.
func (d *DB) CreateUser(ctx context.Context, id, name, createdAt string) error {
	_, err := d.q(ctx).ExecContext(ctx, `INSERT INTO users (id, name, created_at) VALUES (?, ?, ?)`, id, name, createdAt)
	return err
}

// ListUsers returns all accounts by creation time.
func (d *DB) ListUsers(ctx context.Context) ([]models.User, error) {
	rows, err := d.q(ctx).QueryContext(ctx, `SELECT id, name FROM users ORDER BY created_at, name`)
	if err != nil {
		return nil, fmt.Errorf("list users: %w", err)
	}
	defer rows.Close()
	var out []models.User
	for rows.Next() {
		var u models.User
		if err := rows.Scan(&u.ID, &u.Name); err != nil {
			return nil, fmt.Errorf("scan user: %w", err)
		}
		out = append(out, u)
	}
	return out, rows.Err()
}

// UserByID finds an account by its id.
func (d *DB) UserByID(ctx context.Context, id string) (models.User, bool, error) {
	var u models.User
	err := d.q(ctx).QueryRowContext(ctx, `SELECT id, name FROM users WHERE id = ?`, id).Scan(&u.ID, &u.Name)
	if errors.Is(err, sql.ErrNoRows) {
		return models.User{}, false, nil
	}
	if err != nil {
		return models.User{}, false, fmt.Errorf("select user: %w", err)
	}
	return u, true, nil
}

// LastSeq returns the account's sequence counter.
func (d *DB) LastSeq(ctx context.Context, userID string) (int64, error) {
	var seq int64
	if err := d.q(ctx).QueryRowContext(ctx, `SELECT last_seq FROM users WHERE id = ?`, userID).Scan(&seq); err != nil {
		return 0, fmt.Errorf("select last_seq: %w", err)
	}
	return seq, nil
}

// NextSeq increments the account's counter and returns the new value. Call inside WithTx.
func (d *DB) NextSeq(ctx context.Context, userID string) (int64, error) {
	var seq int64
	err := d.q(ctx).QueryRowContext(ctx,
		`UPDATE users SET last_seq = last_seq + 1 WHERE id = ? RETURNING last_seq`, userID).Scan(&seq)
	if err != nil {
		return 0, fmt.Errorf("next seq: %w", err)
	}
	return seq, nil
}

const rowColumns = `user_id, id, seq, status, photo_hash, thumb_hash, has_original, has_thumb,
	updated_at, taken_at, deleted, purged_at, data, received_at`

func scanRow(s interface{ Scan(...any) error }) (models.Row, error) {
	var r models.Row
	var purgedAt sql.NullString
	var data string
	err := s.Scan(&r.UserID, &r.ID, &r.Seq, &r.Status, &r.PhotoHash, &r.ThumbHash, &r.HasOriginal, &r.HasThumb,
		&r.UpdatedAt, &r.TakenAt, &r.Deleted, &purgedAt, &data, &r.ReceivedAt)
	if purgedAt.Valid {
		r.PurgedAt = &purgedAt.String
	}
	r.Data = []byte(data)
	return r, err
}

// GetRow returns the account's row with the given entry id.
func (d *DB) GetRow(ctx context.Context, userID, id string) (models.Row, bool, error) {
	r, err := scanRow(d.q(ctx).QueryRowContext(ctx,
		`SELECT `+rowColumns+` FROM gallery WHERE user_id = ? AND id = ?`, userID, id))
	if errors.Is(err, sql.ErrNoRows) {
		return models.Row{}, false, nil
	}
	if err != nil {
		return models.Row{}, false, fmt.Errorf("select row: %w", err)
	}
	return r, true, nil
}

// InsertRow adds a new gallery row.
func (d *DB) InsertRow(ctx context.Context, r models.Row) error {
	_, err := d.q(ctx).ExecContext(ctx, `INSERT INTO gallery (`+rowColumns+`)
		VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
		r.UserID, r.ID, r.Seq, r.Status, r.PhotoHash, r.ThumbHash, r.HasOriginal, r.HasThumb,
		r.UpdatedAt, r.TakenAt, r.Deleted, r.PurgedAt, string(r.Data), r.ReceivedAt)
	if err != nil {
		return fmt.Errorf("insert row: %w", err)
	}
	return nil
}

// UpdateRow overwrites an existing gallery row. The file hashes are never changed.
func (d *DB) UpdateRow(ctx context.Context, r models.Row) error {
	_, err := d.q(ctx).ExecContext(ctx, `UPDATE gallery SET seq = ?, status = ?, has_original = ?, has_thumb = ?,
		updated_at = ?, taken_at = ?, deleted = ?, purged_at = ?, data = ?, received_at = ?
		WHERE user_id = ? AND id = ?`,
		r.Seq, r.Status, r.HasOriginal, r.HasThumb, r.UpdatedAt, r.TakenAt, r.Deleted, r.PurgedAt,
		string(r.Data), r.ReceivedAt, r.UserID, r.ID)
	if err != nil {
		return fmt.Errorf("update row: %w", err)
	}
	return nil
}

func (d *DB) listRows(ctx context.Context, where string, args ...any) ([]models.Row, error) {
	rows, err := d.q(ctx).QueryContext(ctx, `SELECT `+rowColumns+` FROM gallery WHERE `+where+` ORDER BY seq LIMIT ?`, args...)
	if err != nil {
		return nil, fmt.Errorf("list rows: %w", err)
	}
	defer rows.Close()
	var out []models.Row
	for rows.Next() {
		r, err := scanRow(rows)
		if err != nil {
			return nil, fmt.Errorf("scan row: %w", err)
		}
		out = append(out, r)
	}
	return out, rows.Err()
}

// ListPartial returns up to limit partial rows of the account with seq > after, by ascending seq.
func (d *DB) ListPartial(ctx context.Context, userID string, after int64, limit int) ([]models.Row, error) {
	return d.listRows(ctx, `user_id = ? AND status = 'partial' AND seq > ?`, userID, after, limit)
}

// ListChanges returns up to limit rows of the account with seq > after, by ascending seq.
func (d *DB) ListChanges(ctx context.Context, userID string, after int64, limit int) ([]models.Row, error) {
	return d.listRows(ctx, `user_id = ? AND seq > ?`, userID, after, limit)
}

// HashInUse reports whether any live row of any account has a file with this hash marked as received.
func (d *DB) HashInUse(ctx context.Context, hash string) (bool, error) {
	var n int
	err := d.q(ctx).QueryRowContext(ctx, `SELECT EXISTS (
		SELECT 1 FROM gallery WHERE purged_at IS NULL AND
		((photo_hash = ?1 AND has_original = 1) OR (thumb_hash = ?1 AND has_thumb = 1)))`, hash).Scan(&n)
	if err != nil {
		return false, fmt.Errorf("hash in use: %w", err)
	}
	return n == 1, nil
}

// InsertBlob records a file on disk. Does nothing if it is already recorded.
func (d *DB) InsertBlob(ctx context.Context, hash string, size int64, createdAt string) error {
	_, err := d.q(ctx).ExecContext(ctx,
		`INSERT INTO blobs (hash, size, created_at) VALUES (?, ?, ?) ON CONFLICT (hash) DO NOTHING`, hash, size, createdAt)
	if err != nil {
		return fmt.Errorf("insert blob: %w", err)
	}
	return nil
}

// DeleteBlob removes the record of a file.
func (d *DB) DeleteBlob(ctx context.Context, hash string) error {
	if _, err := d.q(ctx).ExecContext(ctx, `DELETE FROM blobs WHERE hash = ?`, hash); err != nil {
		return fmt.Errorf("delete blob: %w", err)
	}
	return nil
}

// BlobExists reports whether the file is recorded in blobs.
func (d *DB) BlobExists(ctx context.Context, hash string) (bool, error) {
	var n int
	if err := d.q(ctx).QueryRowContext(ctx, `SELECT EXISTS (SELECT 1 FROM blobs WHERE hash = ?)`, hash).Scan(&n); err != nil {
		return false, fmt.Errorf("blob exists: %w", err)
	}
	return n == 1, nil
}
