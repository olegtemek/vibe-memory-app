// Package files keeps blobs on disk, addressed by their SHA-256.
package files

import (
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"syscall"

	"vibe-memory/internal/models"
)

// Store is a blob directory: <root>/blobs/ab/cd/<hash> plus <root>/tmp for uploads in progress.
type Store struct {
	root string
}

// New prepares the data directory: creates it, empties tmp/ and checks that it is writable.
func New(root string) (*Store, error) {
	s := &Store{root: root}
	for _, dir := range []string{root, s.blobsDir(), s.tmpDir()} {
		if err := os.MkdirAll(dir, 0o700); err != nil {
			if errors.Is(err, fs.ErrPermission) {
				// The usual cause in Docker: the mounted host directory belongs to another user.
				return nil, fmt.Errorf("create %s: %w (the data directory must be writable by uid %d, gid %d)",
					dir, err, os.Getuid(), os.Getgid())
			}
			return nil, fmt.Errorf("create %s: %w", dir, err)
		}
	}
	entries, err := os.ReadDir(s.tmpDir())
	if err != nil {
		return nil, fmt.Errorf("read tmp dir: %w", err)
	}
	for _, e := range entries {
		if err := os.RemoveAll(filepath.Join(s.tmpDir(), e.Name())); err != nil {
			return nil, fmt.Errorf("clean tmp dir: %w", err)
		}
	}
	probe, err := os.CreateTemp(s.tmpDir(), "probe-*")
	if err != nil {
		return nil, fmt.Errorf("data dir is not writable: %w", err)
	}
	probe.Close()
	os.Remove(probe.Name())
	return s, nil
}

func (s *Store) blobsDir() string { return filepath.Join(s.root, "blobs") }
func (s *Store) tmpDir() string   { return filepath.Join(s.root, "tmp") }

func (s *Store) path(hash string) (string, error) {
	if !models.ValidHash(hash) {
		return "", fmt.Errorf("invalid hash %q", hash)
	}
	return filepath.Join(s.blobsDir(), hash[:2], hash[2:4], hash), nil
}

// WriteTemp streams r into a new temporary file, computing its SHA-256 on the way.
// The file is fsynced and closed. The caller must Commit or Discard it.
func (s *Store) WriteTemp(r io.Reader) (tmpPath, hash string, size int64, err error) {
	f, err := os.CreateTemp(s.tmpDir(), "upload-*")
	if err != nil {
		return "", "", 0, fmt.Errorf("create temp file: %w", err)
	}
	defer func() {
		if err != nil {
			f.Close()
			os.Remove(f.Name())
		}
	}()
	h := sha256.New()
	size, err = io.Copy(io.MultiWriter(f, h), r)
	if err != nil {
		return "", "", 0, err
	}
	if err = f.Sync(); err != nil {
		return "", "", 0, fmt.Errorf("fsync temp file: %w", err)
	}
	if err = f.Close(); err != nil {
		return "", "", 0, fmt.Errorf("close temp file: %w", err)
	}
	return f.Name(), hex.EncodeToString(h.Sum(nil)), size, nil
}

// Commit moves a temporary file to its permanent place. If a file with this hash already exists,
// the temporary file is removed instead: content-addressed files are identical.
func (s *Store) Commit(tmpPath, hash string) error {
	dst, err := s.path(hash)
	if err != nil {
		return err
	}
	if _, err := os.Stat(dst); err == nil {
		os.Remove(tmpPath)
		return nil
	}
	dir := filepath.Dir(dst)
	if err := os.MkdirAll(dir, 0o700); err != nil {
		return fmt.Errorf("create blob dir: %w", err)
	}
	if err := os.Rename(tmpPath, dst); err != nil {
		return fmt.Errorf("rename blob: %w", err)
	}
	// The new name and any new subdirectories must reach the disk too.
	for _, d := range []string{dir, filepath.Dir(dir), s.blobsDir()} {
		if err := syncDir(d); err != nil {
			return err
		}
	}
	return nil
}

func syncDir(dir string) error {
	d, err := os.Open(dir)
	if err != nil {
		return fmt.Errorf("open dir for fsync: %w", err)
	}
	defer d.Close()
	if err := d.Sync(); err != nil {
		return fmt.Errorf("fsync dir: %w", err)
	}
	return nil
}

// Discard removes a temporary file.
func (s *Store) Discard(tmpPath string) { os.Remove(tmpPath) }

// Open opens a blob for reading. A missing file yields an error matching fs.ErrNotExist.
func (s *Store) Open(hash string) (io.ReadSeekCloser, error) {
	p, err := s.path(hash)
	if err != nil {
		return nil, err
	}
	return os.Open(p)
}

// Exists reports whether the blob is on disk.
func (s *Store) Exists(hash string) bool {
	p, err := s.path(hash)
	if err != nil {
		return false
	}
	_, err = os.Stat(p)
	return err == nil
}

// Remove deletes a blob. A missing file is not an error.
func (s *Store) Remove(hash string) error {
	p, err := s.path(hash)
	if err != nil {
		return err
	}
	if err := os.Remove(p); err != nil && !errors.Is(err, fs.ErrNotExist) {
		return fmt.Errorf("remove blob: %w", err)
	}
	return nil
}

// FreeBytes returns the space available to the server in the data directory.
func (s *Store) FreeBytes() (uint64, error) {
	var st syscall.Statfs_t
	if err := syscall.Statfs(s.root, &st); err != nil {
		return 0, fmt.Errorf("statfs: %w", err)
	}
	return uint64(st.Bavail) * uint64(st.Bsize), nil
}
