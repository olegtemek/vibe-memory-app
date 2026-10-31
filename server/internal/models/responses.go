package models

import "encoding/json"

// API response bodies. Missing is always an array, never null.

// HealthResponse is the body of GET /health.
type HealthResponse struct {
	OK      bool   `json:"ok"`
	Name    string `json:"name"`
	Version string `json:"version"`
}

// StateResponse is the body of GET /gallery/state.
type StateResponse struct {
	LastSeq int64 `json:"lastSeq"`
}

// EntryResult is the state of one entry after POST /gallery.
type EntryResult struct {
	ID      string   `json:"id"`
	Seq     int64    `json:"seq"`
	Status  string   `json:"status"`
	Missing []string `json:"missing"`
}

// PushResponse is the body of POST /gallery.
type PushResponse struct {
	Results []EntryResult `json:"results"`
}

// PartialItem is an entry the server still lacks files for.
type PartialItem struct {
	ID      string   `json:"id"`
	Seq     int64    `json:"seq"`
	Missing []string `json:"missing"`
}

// ChangeItem is the latest version of a changed entry.
type ChangeItem struct {
	Seq     int64           `json:"seq"`
	Status  string          `json:"status"`
	Missing []string        `json:"missing"`
	Entry   json.RawMessage `json:"entry"`
}

// PageResponse is the body of GET /gallery/partial and GET /gallery/changes.
type PageResponse[T any] struct {
	Items   []T  `json:"items"`
	HasMore bool `json:"hasMore"`
}

// FileResponse is the body of PUT /gallery/{id}/{kind}.
type FileResponse struct {
	Seq     int64    `json:"seq"`
	Status  string   `json:"status"`
	Missing []string `json:"missing"`
}

// ErrorResponse is the body of every error answer.
type ErrorResponse struct {
	Error string `json:"error"`
}
