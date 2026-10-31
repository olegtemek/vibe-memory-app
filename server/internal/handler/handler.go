// Package handler is the HTTP layer: routing, CORS, authorization, limits and error mapping.
package handler

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"strings"
	"time"

	"github.com/go-chi/chi/v5"
	"github.com/go-chi/chi/v5/middleware"
	"github.com/go-chi/cors"

	"vibe-memory/internal/models"
)

// Service is the business logic the HTTP layer depends on; *usecase.Service implements it.
type Service interface {
	Authenticate(ctx context.Context, token string) (models.User, error)
	State(ctx context.Context, u models.User) (models.StateResponse, error)
	Push(ctx context.Context, u models.User, req models.PushRequest) (models.PushResponse, error)
	Partial(ctx context.Context, u models.User, p models.PageRequest) (models.PageResponse[models.PartialItem], error)
	Changes(ctx context.Context, u models.User, p models.PageRequest) (models.PageResponse[models.ChangeItem], error)
	PutFile(ctx context.Context, u models.User, id, kind string, body io.Reader) (models.FileResponse, error)
	OpenFile(ctx context.Context, u models.User, id, kind string) (models.File, error)
	MaxFileSize() int64
}

const (
	apiPrefix   = "/api/v1"
	serviceName = "vibe-memory"
)

// Options configure the HTTP layer.
type Options struct {
	AllowedOrigins []string
	Version        string
	// Static serves the PWA on every path outside /api/, without authorization. Nil: API only.
	Static http.Handler
}

type api struct {
	svc     Service
	version string
}

// New builds the full HTTP handler with middleware.
func New(svc Service, opts Options) http.Handler {
	a := &api{svc: svc, version: opts.Version}
	limiter := newAuthLimiter(authFailLimit, time.Minute)

	r := chi.NewRouter()
	r.Use(logRequests)
	if opts.Static != nil {
		r.Use(serveStatic(opts.Static))
	}
	r.Use(cors.Handler(cors.Options{
		AllowedOrigins: opts.AllowedOrigins,
		AllowedMethods: []string{http.MethodGet, http.MethodHead, http.MethodPost, http.MethodPut, http.MethodOptions},
		AllowedHeaders: []string{"Authorization", "Content-Type"},
		MaxAge:         600,
		// Let preflight reach answerPreflight, which replies 204 as the contract requires.
		OptionsPassthrough: true,
	}))
	r.Use(answerPreflight)
	r.Use(authenticate(svc, limiter))
	r.NotFound(func(w http.ResponseWriter, r *http.Request) { writeError(w, http.StatusNotFound, "not found") })
	r.MethodNotAllowed(func(w http.ResponseWriter, r *http.Request) {
		writeError(w, http.StatusMethodNotAllowed, "method not allowed")
	})

	r.Route(apiPrefix, func(r chi.Router) {
		r.Group(func(r chi.Router) {
			r.Use(middleware.RequestSize(models.MaxJSONBody))
			r.Get("/health", a.health)
			r.Get("/gallery/state", a.state)
			r.Post("/gallery", a.push)
			r.Get("/gallery/partial", a.partial)
			r.Get("/gallery/changes", a.changes)
			r.Get("/gallery/{id}/{kind}", a.getFile)
			r.Head("/gallery/{id}/{kind}", a.getFile)
		})
		// The upload limit is enforced by putFile itself.
		r.Put("/gallery/{id}/{kind}", a.putFile)
	})
	return r
}

// serveStatic hands every request outside /api/ to the PWA, before CORS and authorization.
func serveStatic(static http.Handler) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path != "/api" && !strings.HasPrefix(r.URL.Path, "/api/") {
				static.ServeHTTP(w, r)
				return
			}
			next.ServeHTTP(w, r)
		})
	}
}

func (a *api) health(w http.ResponseWriter, r *http.Request) {
	writeJSON(w, http.StatusOK, models.HealthResponse{OK: true, Name: serviceName, Version: a.version})
}

func (a *api) state(w http.ResponseWriter, r *http.Request) {
	res, err := a.svc.State(r.Context(), userFrom(r))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *api) push(w http.ResponseWriter, r *http.Request) {
	var req models.PushRequest
	dec := json.NewDecoder(r.Body)
	if err := dec.Decode(&req); err != nil {
		var tooLarge *http.MaxBytesError
		if errors.As(err, &tooLarge) {
			writeErr(w, r, err)
			return
		}
		writeError(w, http.StatusBadRequest, "invalid JSON")
		return
	}
	if dec.More() {
		writeError(w, http.StatusBadRequest, "invalid JSON: trailing data")
		return
	}
	res, err := a.svc.Push(r.Context(), userFrom(r), req)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *api) partial(w http.ResponseWriter, r *http.Request) {
	p, err := models.ParsePage(r.URL.Query().Get("after"), r.URL.Query().Get("limit"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	res, err := a.svc.Partial(r.Context(), userFrom(r), p)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *api) changes(w http.ResponseWriter, r *http.Request) {
	p, err := models.ParsePage(r.URL.Query().Get("after"), r.URL.Query().Get("limit"))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	res, err := a.svc.Changes(r.Context(), userFrom(r), p)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

// filePath validates {id} and {kind} before any database or disk access.
func filePath(r *http.Request) (id, kind string, ok bool) {
	id, kind = chi.URLParam(r, "id"), chi.URLParam(r, "kind")
	return id, kind, models.ValidUUID(id) && models.ValidKind(kind)
}

func (a *api) putFile(w http.ResponseWriter, r *http.Request) {
	id, kind, ok := filePath(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	limit := a.svc.MaxFileSize()
	if r.ContentLength > limit {
		writeError(w, http.StatusRequestEntityTooLarge, "file is too large")
		return
	}
	res, err := a.svc.PutFile(r.Context(), userFrom(r), id, kind, http.MaxBytesReader(w, r.Body, limit))
	if err != nil {
		writeErr(w, r, err)
		return
	}
	writeJSON(w, http.StatusOK, res)
}

func (a *api) getFile(w http.ResponseWriter, r *http.Request) {
	id, kind, ok := filePath(r)
	if !ok {
		writeError(w, http.StatusNotFound, "not found")
		return
	}
	f, err := a.svc.OpenFile(r.Context(), userFrom(r), id, kind)
	if err != nil {
		writeErr(w, r, err)
		return
	}
	defer f.Content.Close()
	h := w.Header()
	h.Set("Content-Type", "image/jpeg")
	h.Set("ETag", `"`+f.Hash+`"`)
	h.Set("Cache-Control", "private, max-age=31536000, immutable")
	http.ServeContent(w, r, "", time.Time{}, f.Content)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json; charset=utf-8")
	w.WriteHeader(status)
	if err := json.NewEncoder(w).Encode(v); err != nil {
		slog.Error("write response", "err", err)
	}
}

func writeError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, models.ErrorResponse{Error: msg})
}

// writeErr maps a usecase error to a status code. Internal details go to the log only.
func writeErr(w http.ResponseWriter, r *http.Request, err error) {
	var tooLarge *http.MaxBytesError
	switch {
	case errors.Is(err, models.ErrInvalid):
		writeError(w, http.StatusBadRequest, err.Error())
	case errors.Is(err, models.ErrUnauthorized):
		writeError(w, http.StatusUnauthorized, "unauthorized")
	case errors.Is(err, models.ErrNotFound):
		writeError(w, http.StatusNotFound, "not found")
	case errors.Is(err, models.ErrTooLarge), errors.As(err, &tooLarge):
		writeError(w, http.StatusRequestEntityTooLarge, "request body is too large")
	case errors.Is(err, models.ErrNotJPEG):
		writeError(w, http.StatusUnsupportedMediaType, "file is not a JPEG")
	case errors.Is(err, models.ErrHashMismatch):
		writeError(w, http.StatusUnprocessableEntity, "file hash does not match the entry")
	case errors.Is(err, models.ErrNoSpace):
		writeError(w, http.StatusServiceUnavailable, "not enough free disk space")
	default:
		slog.ErrorContext(r.Context(), "internal error", "method", r.Method, "path", r.URL.Path, "err", err)
		writeError(w, http.StatusInternalServerError, "internal error")
	}
}
