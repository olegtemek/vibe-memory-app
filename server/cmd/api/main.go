// Command api runs the vibe-memory home server.
package main

import (
	"context"
	"fmt"
	"log/slog"
	"os"
	"os/signal"
	"syscall"
	"time"

	// Loads .env from the working directory; variables already set in the environment win.
	_ "github.com/joho/godotenv/autoload"

	"vibe-memory/internal/app"
	"vibe-memory/internal/config"
)

// version is set at build time: -ldflags "-X main.version=...".
var version = "dev"

// shutdownTimeout is how long active requests may finish after SIGINT or SIGTERM.
const shutdownTimeout = 30 * time.Second

func main() {
	cfg, err := config.Load()
	if err != nil {
		fmt.Fprintf(os.Stderr, "config: %v\n\n%s\n", err, config.Usage())
		os.Exit(1)
	}
	if len(os.Args) > 1 {
		os.Exit(runCommand(cfg, os.Args[1:]))
	}
	slog.SetDefault(slog.New(slog.NewJSONHandler(os.Stdout, &slog.HandlerOptions{Level: cfg.LogLevel})))

	ctx, stop := signal.NotifyContext(context.Background(), syscall.SIGINT, syscall.SIGTERM)
	defer stop()

	a, err := app.New(ctx, cfg, version)
	if err != nil {
		slog.Error("start failed", "err", err)
		os.Exit(1)
	}

	runErr := make(chan error, 1)
	go func() { runErr <- a.Run() }()

	exitCode := 0
	select {
	case err := <-runErr:
		if err != nil {
			slog.Error("server failed", "err", err)
			exitCode = 1
		}
	case <-ctx.Done():
		slog.Info("shutting down", "timeout", shutdownTimeout.String())
	}
	stop()

	shutdownCtx, cancel := context.WithTimeout(context.Background(), shutdownTimeout)
	defer cancel()
	if err := a.Shutdown(shutdownCtx); err != nil {
		slog.Error("shutdown", "err", err)
		exitCode = 1
	}
	slog.Info("stopped")
	os.Exit(exitCode)
}
