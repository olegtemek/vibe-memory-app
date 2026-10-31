package main

import (
	"context"
	"fmt"
	"os"
	"path/filepath"
	"strings"
	"text/tabwriter"
	"time"

	"github.com/google/uuid"

	"vibe-memory/internal/config"
	"vibe-memory/internal/repository/db"
)

const commandUsage = `usage:
  vibe-memory                  run the server
  vibe-memory user add NAME    create an account and print its token
  vibe-memory user list        print all accounts with their tokens`

// runCommand runs an admin command against the database in VIBE_MEMORY_APP_DATA_DIR and returns the exit code.
// It is safe while the server is running: SQLite serializes the writes.
func runCommand(cfg config.Config, args []string) int {
	if len(args) < 2 || args[0] != "user" {
		fmt.Fprintln(os.Stderr, commandUsage)
		return 2
	}
	ctx := context.Background()
	if err := os.MkdirAll(cfg.DataDir, 0o700); err != nil {
		fmt.Fprintf(os.Stderr, "create data dir: %v\n", err)
		return 1
	}
	database, err := db.Open(ctx, filepath.Join(cfg.DataDir, "vibe_memory.db"))
	if err != nil {
		fmt.Fprintf(os.Stderr, "open database: %v\n", err)
		return 1
	}
	defer database.Close()

	switch {
	case args[1] == "add" && len(args) == 3:
		return addUser(ctx, database, args[2])
	case args[1] == "list" && len(args) == 2:
		return listUsers(ctx, database)
	default:
		fmt.Fprintln(os.Stderr, commandUsage)
		return 2
	}
}

func addUser(ctx context.Context, database *db.DB, name string) int {
	name = strings.TrimSpace(name)
	if name == "" {
		fmt.Fprintln(os.Stderr, "name must not be empty")
		return 2
	}
	// A random UUID v4 in lower case, the format models.ValidUUID accepts.
	token := uuid.NewString()
	if err := database.CreateUser(ctx, token, name, time.Now().UTC().Format(time.RFC3339)); err != nil {
		if strings.Contains(err.Error(), "UNIQUE") {
			fmt.Fprintf(os.Stderr, "user %q already exists; see: vibe-memory user list\n", name)
			return 1
		}
		fmt.Fprintf(os.Stderr, "create user: %v\n", err)
		return 1
	}
	fmt.Println(token)
	return 0
}

func listUsers(ctx context.Context, database *db.DB) int {
	users, err := database.ListUsers(ctx)
	if err != nil {
		fmt.Fprintf(os.Stderr, "%v\n", err)
		return 1
	}
	tw := tabwriter.NewWriter(os.Stdout, 0, 0, 2, ' ', 0)
	fmt.Fprintln(tw, "NAME\tTOKEN")
	for _, u := range users {
		fmt.Fprintf(tw, "%s\t%s\n", u.Name, u.ID)
	}
	tw.Flush()
	return 0
}
