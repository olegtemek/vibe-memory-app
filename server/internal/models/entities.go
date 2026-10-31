package models

import "io"

// User is an account. Its ID is also the bearer token.
type User struct {
	ID   string
	Name string
}

// Location is where a photo was taken.
type Location struct {
	Lat      float64 `json:"lat"`
	Lon      float64 `json:"lon"`
	Accuracy float64 `json:"accuracy"`
}

// Entry is the metadata of one record. It is stored as JSON in gallery.data
// and returned in the change feed exactly in this shape.
type Entry struct {
	ID          string    `json:"id"`
	TakenAt     string    `json:"takenAt"`
	TzOffsetMin int       `json:"tzOffsetMin"`
	DayKey      string    `json:"dayKey"`
	Comment     string    `json:"comment"`
	PhotoHash   string    `json:"photoHash"`
	ThumbHash   string    `json:"thumbHash"`
	Width       int       `json:"width"`
	Height      int       `json:"height"`
	Location    *Location `json:"location"`
	CreatedAt   string    `json:"createdAt"`
	UpdatedAt   string    `json:"updatedAt"`
	Deleted     bool      `json:"deleted"`
	PurgedAt    *string   `json:"purgedAt"`
}

// Row is one row of the gallery table.
type Row struct {
	UserID      string
	ID          string
	Seq         int64
	Status      string
	PhotoHash   string
	ThumbHash   string
	HasOriginal bool
	HasThumb    bool
	UpdatedAt   string
	TakenAt     string
	Deleted     bool
	PurgedAt    *string
	Data        []byte // Entry as JSON
	ReceivedAt  string
}

// Purged reports whether the entry was deleted for good.
func (r Row) Purged() bool { return r.PurgedAt != nil }

// ComputeStatus derives the status from the purge mark and the file marks.
func (r Row) ComputeStatus() string {
	switch {
	case r.Purged():
		return StatusPurged
	case r.HasOriginal && r.HasThumb:
		return StatusComplete
	default:
		return StatusPartial
	}
}

// Missing lists the files the server still lacks. Empty for complete and purged rows.
func (r Row) Missing() []string {
	missing := []string{}
	if r.Purged() {
		return missing
	}
	if !r.HasOriginal {
		missing = append(missing, KindOriginal)
	}
	if !r.HasThumb {
		missing = append(missing, KindThumb)
	}
	return missing
}

// Hash returns the expected SHA-256 of the given file kind.
func (r Row) Hash(kind string) string {
	if kind == KindOriginal {
		return r.PhotoHash
	}
	return r.ThumbHash
}

// Has reports whether the given file kind is marked as received.
func (r Row) Has(kind string) bool {
	if kind == KindOriginal {
		return r.HasOriginal
	}
	return r.HasThumb
}

// File is an opened file of an entry.
type File struct {
	Content io.ReadSeekCloser
	Hash    string
}
