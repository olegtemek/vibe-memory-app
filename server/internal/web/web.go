// Package web serves the PWA built from ../../../pwa-mobile-client. The Docker build copies pwa-mobile-client/dist into dist/ before
// compiling; a plain `go build` embeds only .gitkeep, and the server then serves the API alone.
package web

import (
	"embed"
	"io"
	"io/fs"
	"net/http"
	"path"
	"strings"
	"time"
)

//go:embed all:dist
var embedded embed.FS

// Handler serves the embedded PWA, or returns nil when the build has no index.html.
func Handler() http.Handler {
	dist, err := fs.Sub(embedded, "dist")
	if err != nil {
		return nil
	}
	if _, err := fs.Stat(dist, "index.html"); err != nil {
		return nil
	}
	return &static{fsys: dist}
}

type static struct {
	fsys fs.FS
}

func (s *static) ServeHTTP(w http.ResponseWriter, r *http.Request) {
	if r.Method != http.MethodGet && r.Method != http.MethodHead {
		http.Error(w, "method not allowed", http.StatusMethodNotAllowed)
		return
	}
	name := strings.TrimPrefix(path.Clean("/"+r.URL.Path), "/")
	if info, err := fs.Stat(s.fsys, name); name == "" || err != nil || info.IsDir() {
		// History routing: /day/2026-10-31 and the like get the app shell; a missing asset is a real 404.
		if path.Ext(name) != "" {
			http.NotFound(w, r)
			return
		}
		name = "index.html"
	}

	h := w.Header()
	if strings.HasPrefix(name, "assets/") {
		// Vite puts a content hash into every file name under assets/.
		h.Set("Cache-Control", "public, max-age=31536000, immutable")
	} else {
		// index.html, sw.js and the manifest must be revalidated, or app updates never arrive.
		h.Set("Cache-Control", "no-cache")
	}
	if path.Ext(name) == ".webmanifest" {
		h.Set("Content-Type", "application/manifest+json")
	}
	f, err := s.fsys.Open(name)
	if err != nil {
		http.NotFound(w, r)
		return
	}
	defer f.Close()
	http.ServeContent(w, r, name, time.Time{}, f.(io.ReadSeeker))
}
