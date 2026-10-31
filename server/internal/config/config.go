// Package config reads and checks the server settings from environment variables.
package config

import (
	"fmt"
	"log/slog"
	"net/url"
	"strings"

	"github.com/ilyakaznacheev/cleanenv"
)

// Config is the validated server configuration.
type Config struct {
	Addr           string     `env:"ADDR" env-default:":8080" env-description:"address and port"`
	DataDir        string     `env:"DATA_DIR" env-default:"./data" env-description:"data directory"`
	AllowedOrigins []string   `env:"ALLOWED_ORIGINS" env-default:"http://localhost:5173" env-separator:"," env-description:"PWA origins, comma-separated"`
	MinFreeMB      int64      `env:"MIN_FREE_MB" env-default:"500" env-description:"minimum free disk space for uploads, MB"`
	LogLevel       slog.Level `env:"LOG_LEVEL" env-default:"info" env-description:"debug, info, warn or error"`
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
	if strings.TrimSpace(c.Addr) == "" {
		return fmt.Errorf("ADDR: must not be empty")
	}
	if strings.TrimSpace(c.DataDir) == "" {
		return fmt.Errorf("DATA_DIR: must not be empty")
	}
	if c.MinFreeMB < 0 {
		return fmt.Errorf("MIN_FREE_MB: want a non-negative integer, got %d", c.MinFreeMB)
	}

	origins := make([]string, 0, len(c.AllowedOrigins))
	for _, o := range c.AllowedOrigins {
		o = strings.TrimSpace(o)
		if o == "" {
			continue
		}
		u, err := url.Parse(o)
		if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.Host == "" || (u.Path != "" && u.Path != "/") {
			return fmt.Errorf("ALLOWED_ORIGINS: %q is not an origin like https://example.com", o)
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
