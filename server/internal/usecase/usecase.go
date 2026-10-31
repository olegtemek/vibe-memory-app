// Package usecase holds the business rules of the server: entry validation, last write wins,
// sequence numbers, file statuses, uploads and cleanup. It knows nothing about HTTP.
package usecase

import (
	"bufio"
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"log/slog"
	"sync"
	"time"

	"vibe-memory/internal/models"
)

// Store is the database. Calls made with the ctx that WithTx passes to fn run in that transaction.
type Store interface {
	WithTx(ctx context.Context, fn func(ctx context.Context) error) error
	UserByID(ctx context.Context, id string) (models.User, bool, error)
	LastSeq(ctx context.Context, userID string) (int64, error)
	NextSeq(ctx context.Context, userID string) (int64, error)
	GetRow(ctx context.Context, userID, id string) (models.Row, bool, error)
	InsertRow(ctx context.Context, r models.Row) error
	UpdateRow(ctx context.Context, r models.Row) error
	ListPartial(ctx context.Context, userID string, after int64, limit int) ([]models.Row, error)
	ListChanges(ctx context.Context, userID string, after int64, limit int) ([]models.Row, error)
	HashInUse(ctx context.Context, hash string) (bool, error)
	InsertBlob(ctx context.Context, hash string, size int64, createdAt string) error
	DeleteBlob(ctx context.Context, hash string) error
}

// Files is the blob storage on disk.
type Files interface {
	WriteTemp(r io.Reader) (tmpPath, hash string, size int64, err error)
	Commit(tmpPath, hash string) error
	Discard(tmpPath string)
	Open(hash string) (io.ReadSeekCloser, error)
	Remove(hash string) error
	FreeBytes() (uint64, error)
}

// Options tune the service. Zero values take defaults.
type Options struct {
	MinFreeBytes uint64
	MaxFileSize  int64
	Now          func() time.Time
}

// Service implements the server's operations for one authenticated user at a time.
type Service struct {
	store   Store
	files   Files
	minFree uint64
	maxFile int64
	now     func() time.Time

	// blobMu orders blob creation (PUT) against blob cleanup (purge), so that a file
	// being marked by an upload is never deleted by a concurrent purge of another row.
	blobMu sync.Mutex
}

// New creates the service.
func New(store Store, files Files, opts Options) *Service {
	s := &Service{store: store, files: files, minFree: opts.MinFreeBytes, maxFile: opts.MaxFileSize, now: opts.Now}
	if s.maxFile <= 0 {
		s.maxFile = models.DefaultMaxFileSize
	}
	if s.now == nil {
		s.now = time.Now
	}
	return s
}

// MaxFileSize is the upload limit for one file, in bytes.
func (s *Service) MaxFileSize() int64 { return s.maxFile }

func (s *Service) timestamp() string { return s.now().UTC().Format(time.RFC3339) }

// Authenticate finds the user whose id equals the token.
func (s *Service) Authenticate(ctx context.Context, token string) (models.User, error) {
	if !models.ValidUUID(token) {
		return models.User{}, models.ErrUnauthorized
	}
	u, ok, err := s.store.UserByID(ctx, token)
	if err != nil {
		return models.User{}, err
	}
	if !ok {
		return models.User{}, models.ErrUnauthorized
	}
	return u, nil
}

// State returns the user's last sequence number.
func (s *Service) State(ctx context.Context, u models.User) (models.StateResponse, error) {
	seq, err := s.store.LastSeq(ctx, u.ID)
	return models.StateResponse{LastSeq: seq}, err
}

// Push merges a batch of entries by last write wins. Rejected entries are logged and left out of the result.
func (s *Service) Push(ctx context.Context, u models.User, req models.PushRequest) (models.PushResponse, error) {
	if len(req.Entries) < 1 || len(req.Entries) > models.MaxBatch {
		return models.PushResponse{}, fmt.Errorf("%w: want 1 to %d entries, got %d",
			models.ErrInvalid, models.MaxBatch, len(req.Entries))
	}

	s.blobMu.Lock()
	defer s.blobMu.Unlock()

	var results []models.EntryResult
	var orphans []string
	err := s.store.WithTx(ctx, func(ctx context.Context) error {
		results, orphans = nil, nil
		purgedHashes := map[string]bool{}
		for i, raw := range req.Entries {
			e, err := models.ParseEntry(raw)
			if err != nil {
				slog.WarnContext(ctx, "entry rejected", "user", u.Name, "index", i, "reason", err.Error())
				continue
			}
			row, purged, err := s.merge(ctx, u, e)
			if errors.Is(err, models.ErrInvalid) {
				slog.WarnContext(ctx, "entry rejected", "user", u.Name, "id", e.ID, "reason", err.Error())
				continue
			}
			if err != nil {
				return err
			}
			if purged {
				purgedHashes[row.PhotoHash] = true
				purgedHashes[row.ThumbHash] = true
			}
			results = append(results, models.EntryResult{ID: row.ID, Seq: row.Seq, Status: row.Status, Missing: row.Missing()})
		}
		for h := range purgedHashes {
			used, err := s.store.HashInUse(ctx, h)
			if err != nil {
				return err
			}
			if used {
				continue
			}
			if err := s.store.DeleteBlob(ctx, h); err != nil {
				return err
			}
			orphans = append(orphans, h)
		}
		return nil
	})
	if err != nil {
		return models.PushResponse{}, err
	}

	// Files go only after the commit: a crash in between leaves a harmless unreferenced file.
	for _, h := range orphans {
		if err := s.files.Remove(h); err != nil {
			slog.ErrorContext(ctx, "remove purged blob", "hash", h, "err", err)
		}
	}
	if results == nil {
		results = []models.EntryResult{}
	}
	return models.PushResponse{Results: results}, nil
}

// merge applies one valid entry inside the Push transaction. It returns the row after the merge
// and whether the row has just become purged.
func (s *Service) merge(ctx context.Context, u models.User, e models.Entry) (models.Row, bool, error) {
	row, found, err := s.store.GetRow(ctx, u.ID, e.ID)
	if err != nil {
		return models.Row{}, false, err
	}
	if found && (row.PhotoHash != e.PhotoHash || row.ThumbHash != e.ThumbHash) {
		return models.Row{}, false, fmt.Errorf("%w: file hashes of an existing entry cannot change", models.ErrInvalid)
	}
	if found && (row.Purged() || e.UpdatedAt <= row.UpdatedAt) {
		return row, false, nil
	}

	data, err := json.Marshal(e)
	if err != nil {
		return models.Row{}, false, fmt.Errorf("encode entry: %w", err)
	}
	seq, err := s.store.NextSeq(ctx, u.ID)
	if err != nil {
		return models.Row{}, false, err
	}
	next := models.Row{
		UserID:      u.ID,
		ID:          e.ID,
		Seq:         seq,
		PhotoHash:   e.PhotoHash,
		ThumbHash:   e.ThumbHash,
		HasOriginal: row.HasOriginal,
		HasThumb:    row.HasThumb,
		UpdatedAt:   e.UpdatedAt,
		TakenAt:     e.TakenAt,
		Deleted:     e.Deleted,
		PurgedAt:    e.PurgedAt,
		Data:        data,
		ReceivedAt:  s.timestamp(),
	}
	if next.Purged() {
		next.HasOriginal, next.HasThumb = false, false
	}
	next.Status = next.ComputeStatus()

	if found {
		err = s.store.UpdateRow(ctx, next)
	} else {
		err = s.store.InsertRow(ctx, next)
	}
	if err != nil {
		return models.Row{}, false, err
	}
	return next, next.Purged(), nil
}

// Partial lists the user's partial entries after p.After.
func (s *Service) Partial(ctx context.Context, u models.User, p models.PageRequest) (models.PageResponse[models.PartialItem], error) {
	rows, err := s.store.ListPartial(ctx, u.ID, p.After, p.Limit+1)
	if err != nil {
		return models.PageResponse[models.PartialItem]{}, err
	}
	rows, hasMore := trimPage(rows, p.Limit)
	items := make([]models.PartialItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, models.PartialItem{ID: r.ID, Seq: r.Seq, Missing: r.Missing()})
	}
	return models.PageResponse[models.PartialItem]{Items: items, HasMore: hasMore}, nil
}

// Changes lists the user's rows changed after p.After.
func (s *Service) Changes(ctx context.Context, u models.User, p models.PageRequest) (models.PageResponse[models.ChangeItem], error) {
	rows, err := s.store.ListChanges(ctx, u.ID, p.After, p.Limit+1)
	if err != nil {
		return models.PageResponse[models.ChangeItem]{}, err
	}
	rows, hasMore := trimPage(rows, p.Limit)
	items := make([]models.ChangeItem, 0, len(rows))
	for _, r := range rows {
		items = append(items, models.ChangeItem{Seq: r.Seq, Status: r.Status, Missing: r.Missing(), Entry: r.Data})
	}
	return models.PageResponse[models.ChangeItem]{Items: items, HasMore: hasMore}, nil
}

// trimPage cuts rows fetched with limit+1 to limit and reports whether more exist.
func trimPage(rows []models.Row, limit int) ([]models.Row, bool) {
	if len(rows) > limit {
		return rows[:limit], true
	}
	return rows, false
}

var jpegMagic = []byte{0xFF, 0xD8, 0xFF}

// PutFile stores one file of an entry after checking it against the entry's hash.
func (s *Service) PutFile(ctx context.Context, u models.User, id, kind string, body io.Reader) (models.FileResponse, error) {
	if !models.ValidUUID(id) || !models.ValidKind(kind) {
		return models.FileResponse{}, models.ErrNotFound
	}
	row, found, err := s.store.GetRow(ctx, u.ID, id)
	if err != nil {
		return models.FileResponse{}, err
	}
	if !found || row.Purged() {
		return models.FileResponse{}, models.ErrNotFound
	}

	free, err := s.files.FreeBytes()
	if err != nil {
		return models.FileResponse{}, err
	}
	if free < s.minFree {
		slog.ErrorContext(ctx, "upload refused: low disk space", "free_bytes", free, "min_free_bytes", s.minFree)
		return models.FileResponse{}, models.ErrNoSpace
	}

	// Read one byte past the limit so that an oversized body is detectable.
	limited := &io.LimitedReader{R: body, N: s.maxFile + 1}
	br := bufio.NewReader(limited)
	head, err := br.Peek(len(jpegMagic))
	if err != nil && !errors.Is(err, io.EOF) {
		return models.FileResponse{}, err
	}
	if !bytes.Equal(head, jpegMagic) {
		return models.FileResponse{}, models.ErrNotJPEG
	}

	tmp, hash, size, err := s.files.WriteTemp(br)
	if err != nil {
		return models.FileResponse{}, err
	}
	if size > s.maxFile {
		s.files.Discard(tmp)
		return models.FileResponse{}, models.ErrTooLarge
	}
	if hash != row.Hash(kind) {
		s.files.Discard(tmp)
		return models.FileResponse{}, models.ErrHashMismatch
	}

	s.blobMu.Lock()
	defer s.blobMu.Unlock()

	if err := s.files.Commit(tmp, hash); err != nil {
		s.files.Discard(tmp)
		return models.FileResponse{}, err
	}

	var res models.FileResponse
	err = s.store.WithTx(ctx, func(ctx context.Context) error {
		row, found, err := s.store.GetRow(ctx, u.ID, id)
		if err != nil {
			return err
		}
		if !found || row.Purged() {
			return models.ErrNotFound
		}
		if err := s.store.InsertBlob(ctx, hash, size, s.timestamp()); err != nil {
			return err
		}
		if !row.Has(kind) {
			if kind == models.KindOriginal {
				row.HasOriginal = true
			} else {
				row.HasThumb = true
			}
			row.Status = row.ComputeStatus()
			if row.Seq, err = s.store.NextSeq(ctx, u.ID); err != nil {
				return err
			}
			row.ReceivedAt = s.timestamp()
			if err := s.store.UpdateRow(ctx, row); err != nil {
				return err
			}
		}
		res = models.FileResponse{Seq: row.Seq, Status: row.Status, Missing: row.Missing()}
		return nil
	})
	if err != nil {
		return models.FileResponse{}, err
	}
	return res, nil
}

// OpenFile opens a received file of the user's entry. Every kind of absence is ErrNotFound.
func (s *Service) OpenFile(ctx context.Context, u models.User, id, kind string) (models.File, error) {
	if !models.ValidUUID(id) || !models.ValidKind(kind) {
		return models.File{}, models.ErrNotFound
	}
	row, found, err := s.store.GetRow(ctx, u.ID, id)
	if err != nil {
		return models.File{}, err
	}
	if !found || row.Purged() || !row.Has(kind) {
		return models.File{}, models.ErrNotFound
	}
	hash := row.Hash(kind)
	f, err := s.files.Open(hash)
	if errors.Is(err, fs.ErrNotExist) {
		slog.ErrorContext(ctx, "marked file is missing on disk", "user", u.Name, "id", id, "kind", kind, "hash", hash)
		return models.File{}, models.ErrNotFound
	}
	if err != nil {
		return models.File{}, err
	}
	return models.File{Content: f, Hash: hash}, nil
}
