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

	"vibe-memory/internal/config"
	"vibe-memory/internal/handler"
	"vibe-memory/internal/repository/db"
	"vibe-memory/internal/repository/files"
	"vibe-memory/internal/usecase"
	"vibe-memory/internal/web"
)

// App is the assembled server. Create it with New, start it with Run, stop it with Shutdown.
type App struct {
	server *http.Server
	db     *db.DB
}

// New prepares the data directory, opens and migrates the database and builds the HTTP server.
// Nothing listens yet.
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
	static := web.Handler()
	h := handler.New(svc, handler.Options{AllowedOrigins: cfg.AllowedOrigins, Version: version, Static: static})
	slog.Info("starting", "version", version, "data_dir", cfg.DataDir, "allowed_origins", cfg.AllowedOrigins,
		"pwa", static != nil)

	return &App{server: handler.NewServer(cfg.Addr, h), db: database}, nil
}

// Run listens and serves until Shutdown is called. It returns nil after a clean shutdown.
func (a *App) Run() error {
	ln, err := net.Listen("tcp", a.server.Addr)
	if err != nil {
		return fmt.Errorf("listen %s: %w", a.server.Addr, err)
	}
	slog.Info("server started", "addr", ln.Addr().String())
	if err := a.server.Serve(ln); !errors.Is(err, http.ErrServerClosed) {
		return err
	}
	return nil
}

// Shutdown stops accepting connections, waits for active requests until ctx expires
// and closes the database. Requests still running after the deadline are cut off.
func (a *App) Shutdown(ctx context.Context) error {
	err := a.server.Shutdown(ctx)
	if err != nil {
		a.server.Close()
		err = fmt.Errorf("shutdown: %w", err)
	}
	if cerr := a.db.Close(); cerr != nil {
		err = errors.Join(err, fmt.Errorf("close database: %w", cerr))
	}
	return err
}
