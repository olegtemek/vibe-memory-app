// Package models holds everything shared by the layers: entities, request and response shapes,
// errors, constants and format checks.
package models

import (
	"errors"
	"regexp"
)

// Errors returned by the use cases. Callers match them with errors.Is.
var (
	ErrInvalid      = errors.New("invalid request")
	ErrNotFound     = errors.New("not found")
	ErrHashMismatch = errors.New("file hash does not match the entry")
	ErrNotJPEG      = errors.New("file is not a JPEG")
	ErrTooLarge     = errors.New("file is too large")
	ErrNoSpace      = errors.New("not enough free disk space")
	ErrUnauthorized = errors.New("unauthorized")
)

// Gallery row statuses.
const (
	StatusPartial  = "partial"
	StatusComplete = "complete"
	StatusPurged   = "purged"
)

// File kinds of an entry.
const (
	KindOriginal = "original"
	KindThumb    = "thumb"
)

// Limits.
const (
	MaxBatch           = 20       // entries per POST /gallery
	MaxComment         = 5000     // runes in Entry.Comment
	DefaultMaxFileSize = 25 << 20 // bytes per uploaded file
	MaxJSONBody        = 1 << 20  // bytes per request body except file uploads
	DefaultPageLimit   = 100
	MaxPageLimit       = 500
)

// Formats.
const (
	TimeLayout   = "2006-01-02T15:04:05.000Z" // Date.prototype.toISOString()
	DayKeyLayout = "2006-01-02"
)

var (
	uuidRe   = regexp.MustCompile(`^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$`)
	hashRe   = regexp.MustCompile(`^[0-9a-f]{64}$`)
	timeRe   = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$`)
	dayKeyRe = regexp.MustCompile(`^\d{4}-\d{2}-\d{2}$`)
)

// ValidUUID reports whether s is a UUID in canonical lower-case form.
func ValidUUID(s string) bool { return uuidRe.MatchString(s) }

// ValidHash reports whether s is a lower-case hex SHA-256.
func ValidHash(s string) bool { return hashRe.MatchString(s) }

// ValidKind reports whether s names a file of an entry.
func ValidKind(s string) bool { return s == KindOriginal || s == KindThumb }
