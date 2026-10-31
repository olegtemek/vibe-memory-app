package models

import (
	"encoding/json"
	"fmt"
	"math"
	"strconv"
	"time"
	"unicode/utf8"
)

// PushRequest is the body of POST /gallery. Entries stay raw: each one is validated on its own,
// so that one bad entry does not reject the batch.
type PushRequest struct {
	Entries []json.RawMessage `json:"entries"`
}

// EntryRequest is one incoming entry. Pointers make missing fields and wrong types detectable;
// unknown fields are dropped by json.Unmarshal.
type EntryRequest struct {
	ID          *string         `json:"id"`
	TakenAt     *string         `json:"takenAt"`
	TzOffsetMin *float64        `json:"tzOffsetMin"`
	DayKey      *string         `json:"dayKey"`
	Comment     *string         `json:"comment"`
	PhotoHash   *string         `json:"photoHash"`
	ThumbHash   *string         `json:"thumbHash"`
	Width       *float64        `json:"width"`
	Height      *float64        `json:"height"`
	Location    json.RawMessage `json:"location"`
	CreatedAt   *string         `json:"createdAt"`
	UpdatedAt   *string         `json:"updatedAt"`
	Deleted     *bool           `json:"deleted"`
	PurgedAt    *string         `json:"purgedAt"`
}

// LocationRequest is the incoming location of an entry.
type LocationRequest struct {
	Lat      *float64 `json:"lat"`
	Lon      *float64 `json:"lon"`
	Accuracy *float64 `json:"accuracy"`
}

// PageRequest is the after/limit pair of the list endpoints.
type PageRequest struct {
	After int64
	Limit int
}

func invalid(format string, args ...any) error {
	return fmt.Errorf("%w: %s", ErrInvalid, fmt.Sprintf(format, args...))
}

// ParseEntry decodes and validates one entry of a POST /gallery batch. Errors match ErrInvalid.
func ParseEntry(raw json.RawMessage) (Entry, error) {
	var r EntryRequest
	if err := json.Unmarshal(raw, &r); err != nil {
		return Entry{}, invalid("decode entry: %v", err)
	}
	return r.Validate()
}

// Validate checks the request and converts it to an Entry. Errors match ErrInvalid.
func (r EntryRequest) Validate() (Entry, error) {
	var e Entry

	if r.ID == nil || !ValidUUID(*r.ID) {
		return e, invalid("id: want a lower-case UUID")
	}
	e.ID = *r.ID

	for _, f := range []struct {
		name string
		src  *string
		dst  *string
	}{
		{"takenAt", r.TakenAt, &e.TakenAt},
		{"createdAt", r.CreatedAt, &e.CreatedAt},
		{"updatedAt", r.UpdatedAt, &e.UpdatedAt},
	} {
		if f.src == nil || !validTime(*f.src) {
			return e, invalid("%s: want YYYY-MM-DDTHH:MM:SS.sssZ", f.name)
		}
		*f.dst = *f.src
	}
	if r.PurgedAt != nil {
		if !validTime(*r.PurgedAt) {
			return e, invalid("purgedAt: want YYYY-MM-DDTHH:MM:SS.sssZ or null")
		}
		p := *r.PurgedAt
		e.PurgedAt = &p
	}

	tz, ok := intIn(r.TzOffsetMin, -720, 840)
	if !ok {
		return e, invalid("tzOffsetMin: want an integer from -720 to 840")
	}
	e.TzOffsetMin = tz

	if r.DayKey == nil || !dayKeyRe.MatchString(*r.DayKey) {
		return e, invalid("dayKey: want YYYY-MM-DD")
	}
	if _, err := time.Parse(DayKeyLayout, *r.DayKey); err != nil {
		return e, invalid("dayKey: not a real date")
	}
	e.DayKey = *r.DayKey

	if r.Comment == nil || utf8.RuneCountInString(*r.Comment) > MaxComment {
		return e, invalid("comment: want a string of at most %d characters", MaxComment)
	}
	e.Comment = *r.Comment

	if r.PhotoHash == nil || !ValidHash(*r.PhotoHash) {
		return e, invalid("photoHash: want a lower-case hex SHA-256")
	}
	if r.ThumbHash == nil || !ValidHash(*r.ThumbHash) {
		return e, invalid("thumbHash: want a lower-case hex SHA-256")
	}
	e.PhotoHash, e.ThumbHash = *r.PhotoHash, *r.ThumbHash

	if e.Width, ok = intIn(r.Width, 1, 10000); !ok {
		return e, invalid("width: want an integer from 1 to 10000")
	}
	if e.Height, ok = intIn(r.Height, 1, 10000); !ok {
		return e, invalid("height: want an integer from 1 to 10000")
	}

	if len(r.Location) > 0 && string(r.Location) != "null" {
		var l LocationRequest
		if err := json.Unmarshal(r.Location, &l); err != nil {
			return e, invalid("location: want an object or null")
		}
		if l.Lat == nil || *l.Lat < -90 || *l.Lat > 90 ||
			l.Lon == nil || *l.Lon < -180 || *l.Lon > 180 ||
			l.Accuracy == nil || *l.Accuracy < 0 || *l.Accuracy > 100000 {
			return e, invalid("location: lat, lon or accuracy out of range")
		}
		e.Location = &Location{Lat: *l.Lat, Lon: *l.Lon, Accuracy: *l.Accuracy}
	}

	if r.Deleted == nil {
		return e, invalid("deleted: want a boolean")
	}
	e.Deleted = *r.Deleted
	return e, nil
}

func validTime(s string) bool {
	if !timeRe.MatchString(s) {
		return false
	}
	_, err := time.Parse(TimeLayout, s)
	return err == nil
}

func intIn(v *float64, lo, hi int) (int, bool) {
	if v == nil || *v != math.Trunc(*v) || *v < float64(lo) || *v > float64(hi) {
		return 0, false
	}
	return int(*v), true
}

// ParsePage validates the after and limit query parameters; empty values take the defaults.
// Errors match ErrInvalid.
func ParsePage(after, limit string) (PageRequest, error) {
	p := PageRequest{Limit: DefaultPageLimit}
	if after != "" {
		n, err := parseDigits(after)
		if err != nil {
			return p, invalid("after: want an integer >= 0")
		}
		p.After = n
	}
	if limit != "" {
		n, err := parseDigits(limit)
		if err != nil || n < 1 || n > MaxPageLimit {
			return p, invalid("limit: want an integer from 1 to %d", MaxPageLimit)
		}
		p.Limit = int(n)
	}
	return p, nil
}

// parseDigits accepts only plain decimal digits: no sign, spaces or exponent.
func parseDigits(s string) (int64, error) {
	for _, c := range s {
		if c < '0' || c > '9' {
			return 0, strconv.ErrSyntax
		}
	}
	return strconv.ParseInt(s, 10, 64)
}
