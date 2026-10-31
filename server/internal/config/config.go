// Package config reads and checks the server settings from environment variables.
package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"github.com/ilyakaznacheev/cleanenv"
)

// Config is the validated server configuration. Every variable has the VIBE_MEMORY_ prefix.
type Config struct {
	ServerPort     int        `env:"VIBE_MEMORY_SERVER_PORT" env-default:"8000" env-description:"port of the API"`
	WebPort        int        `env:"VIBE_MEMORY_WEB_PORT" env-default:"8080" env-description:"port of the PWA, with the API on the same origin; 0: off"`
	AllowedOrigins []string   `env:"VIBE_MEMORY_SERVER_CORS_ORIGINS" env-default:"*" env-separator:"," env-description:"origins allowed to call the API, comma-separated; * allows any"`
	DataDir        string     `env:"VIBE_MEMORY_APP_DATA_DIR" env-default:"./data" env-description:"data directory"`
	MinFreeMB      int64      `env:"VIBE_MEMORY_APP_MIN_FREE_MB" env-default:"500" env-description:"minimum free disk space for uploads, MB"`
	LogLevel       slog.Level `env:"VIBE_MEMORY_APP_LOG_LEVEL" env-default:"info" env-description:"debug, info, warn or error"`
}

// Addr is the listen address of the API.
func (c Config) Addr() string { return fmt.Sprintf(":%d", c.ServerPort) }

// WebAddr is the listen address of the PWA, or "" when it is off.
func (c Config) WebAddr() string {
	if c.WebPort == 0 {
		return ""
	}
	return fmt.Sprintf(":%d", c.WebPort)
}

// Load reads the configuration from the environment and validates it.
func Load() (Config, error) {
	var cfg Config
	if err := cleanenv.ReadEnv(&cfg); err != nil {
		return Config{}, err
	}
	if err := cfg.validate(); err != nil {
		return Config{}, err
	}
	return cfg, nil
}

func (c *Config) validate() error {
	if c.ServerPort < 1 || c.ServerPort > 65535 {
		return fmt.Errorf("VIBE_MEMORY_SERVER_PORT: want a port from 1 to 65535, got %d", c.ServerPort)
	}
	if c.WebPort < 0 || c.WebPort > 65535 {
		return fmt.Errorf("VIBE_MEMORY_WEB_PORT: want a port from 1 to 65535 or 0 to turn it off, got %d", c.WebPort)
	}
	if c.WebPort == c.ServerPort {
		return fmt.Errorf("VIBE_MEMORY_WEB_PORT: must differ from VIBE_MEMORY_SERVER_PORT (%d)", c.ServerPort)
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("VIBE_MEMORY_APP_DATA_DIR: must not be empty")
	}
	if c.MinFreeMB < 0 {
		return fmt.Errorf("VIBE_MEMORY_APP_MIN_FREE_MB: want a non-negative integer, got %d", c.MinFreeMB)
	}

	origins := make([]string, 0, len(c.AllowedOrigins))
	for _, o := range c.AllowedOrigins {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		// go-chi/cors treats * as any origin. The API needs no cookies, only the bearer token.
		if o == "*" {
			origins = append(origins, o)
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
			return fmt.Errorf("VIBE_MEMORY_SERVER_CORS_ORIGINS: %q is not * or an origin like https://example.com", o)
		}
		origins = append(origins, strings.TrimSuffix(o, "/"))
	}
	c.AllowedOrigins = origins
	return nil
}

// Usage describes the environment variables, for error messages.
func Usage() string {
	text, err := cleanenv.GetDescription(&Config{}, nil)
	if err != nil {
		return ""
	}
	return text
}
