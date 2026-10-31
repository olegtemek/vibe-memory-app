// Package app wires the layers together: repositories, use cases and the HTTP server.
package app

import (
	"context"
	"errors"
	"fmt"
	"log/slog"
	"net"
	"net/http"
	"path/filepath"
	"sync"

	"vibe-memory/internal/config"
	"vibe-memory/internal/handler"
	"vibe-memory/internal/repository/db"
	"vibe-memory/internal/repository/files"
	"vibe-memory/internal/usecase"
	"vibe-memory/internal/web"
)

// App is the assembled server. Create it with New, start it with Run, stop it with Shutdown.
type App struct {
	servers []namedServer
	db      *db.DB
}

type namedServer struct {
	name string
	*http.Server
}

// New prepares the data directory, opens and migrates the database and builds the HTTP servers:
// the API on VIBE_MEMORY_SERVER_PORT and, when the PWA is built in, the PWA with the API on VIBE_MEMORY_WEB_PORT. Nothing listens yet.
func New(ctx context.Context, cfg config.Config, version string) (*App, error) {
	fileStore, err := files.New(cfg.DataDir)
	if err != nil {
		return nil, err
	}
	database, err := db.Open(ctx, filepath.Join(cfg.DataDir, "vibe_memory.db"))
	if err != nil {
		return nil, err
	}

	svc := usecase.New(database, fileStore, usecase.Options{MinFreeBytes: uint64(cfg.MinFreeMB) << 20})
	opts := handler.Options{AllowedOrigins: cfg.AllowedOrigins, Version: version}
	a := &App{db: database}
	a.servers = append(a.servers, namedServer{"api", handler.NewServer(cfg.Addr(), handler.New(svc, opts))})

	static := web.Handler()
	switch {
	case cfg.WebAddr() == "":
	case static == nil:
		slog.Warn("PWA is not built in, VIBE_MEMORY_WEB_PORT is ignored", "web_port", cfg.WebPort)
	default:
		// The PWA calls the API on its own origin, so it needs no CORS and no address typed in.
		opts.Static = static
		a.servers = append(a.servers, namedServer{"pwa+api", handler.NewServer(cfg.WebAddr(), handler.New(svc, opts))})
	}
	slog.Info("starting", "version", version, "data_dir", cfg.DataDir, "cors_origins", cfg.AllowedOrigins)
	return a, nil
}

// Run listens and serves until Shutdown is called. It returns nil after a clean shutdown
// and the first error if any server fails.
func (a *App) Run() error {
	listeners := make([]net.Listener, 0, len(a.servers))
	for _, s := range a.servers {
		ln, err := net.Listen("tcp", s.Addr)
		if err != nil {
			for _, l := range listeners {
				l.Close()
			}
			return fmt.Errorf("listen %s: %w", s.Addr, err)
		}
		listeners = append(listeners, ln)
	}
	errs := make(chan error, len(a.servers))
	for i, s := range a.servers {
		slog.Info("server started", "serves", s.name, "addr", listeners[i].Addr().String())
		go func() { errs <- s.Serve(listeners[i]) }()
	}
	for range a.servers {
		if err := <-errs; !errors.Is(err, http.ErrServerClosed) {
			return err
		}
	}
	return nil
}

// Shutdown stops accepting connections, waits for active requests until ctx expires
// and closes the database. Requests still running after the deadline are cut off.
func (a *App) Shutdown(ctx context.Context) error {
	errs := make([]error, len(a.servers))
	var wg sync.WaitGroup
	for i, s := range a.servers {
		wg.Add(1)
		go func() {
			defer wg.Done()
			if err := s.Shutdown(ctx); err != nil {
				s.Close()
				errs[i] = fmt.Errorf("shutdown %s: %w", s.name, err)
			}
		}()
	}
	wg.Wait()
	err := errors.Join(errs...)
	if cerr := a.db.Close(); cerr != nil {
		err = errors.Join(err, fmt.Errorf("close database: %w", cerr))
	}
	return err
}
