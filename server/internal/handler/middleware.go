package handler

import (
	"context"
	"errors"
	"log/slog"
	"net"
	"net/http"
	"strings"
	"sync"
	"time"

	"github.com/go-chi/chi/v5/middleware"

	"vibe-memory/internal/models"
)

// reqInfo is filled while a request passes the middleware and read by the access log.
type reqInfo struct {
	user string
}

type infoKey struct{}
type userKey struct{}

func userFrom(r *http.Request) models.User {
	u, _ := r.Context().Value(userKey{}).(models.User)
	return u
}

// logRequests writes one JSON line per request through the default slog logger and turns panics into 500.
// Query strings, tokens and bodies never reach the log.
func logRequests(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		start := time.Now()
		info := &reqInfo{}
		ww := middleware.NewWrapResponseWriter(w, r.ProtoMajor)
		r = r.WithContext(context.WithValue(r.Context(), infoKey{}, info))
		defer func() {
			if p := recover(); p != nil {
				if p == http.ErrAbortHandler {
					panic(p)
				}
				slog.ErrorContext(r.Context(), "panic", "method", r.Method, "path", r.URL.Path, "panic", p)
				if ww.Status() == 0 {
					writeError(ww, http.StatusInternalServerError, "internal error")
				}
			}
			slog.InfoContext(r.Context(), "request",
				"method", r.Method,
				"path", r.URL.Path,
				"status", ww.Status(),
				"duration_ms", time.Since(start).Milliseconds(),
				"bytes", ww.BytesWritten(),
				"user", info.user,
			)
		}()
		next.ServeHTTP(ww, r)
	})
}

// answerPreflight ends CORS preflight requests with 204, before authorization:
// browsers do not send Authorization in a preflight. The CORS headers are set by go-chi/cors.
func answerPreflight(next http.Handler) http.Handler {
	return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		if r.Method == http.MethodOptions && r.Header.Get("Access-Control-Request-Method") != "" {
			w.WriteHeader(http.StatusNoContent)
			return
		}
		next.ServeHTTP(w, r)
	})
}

const authFailLimit = 20

// authenticate resolves the bearer token to a user. Missing, malformed and unknown tokens
// all get the same 401; an IP with too many 401s gets 429 until its window ends.
// The health check is open, for Docker and monitoring.
func authenticate(svc Service, limiter *authLimiter) func(http.Handler) http.Handler {
	return func(next http.Handler) http.Handler {
		return http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
			if r.URL.Path == healthPath {
				next.ServeHTTP(w, r)
				return
			}
			ip := clientIP(r)
			if limiter.blocked(ip) {
				writeError(w, http.StatusTooManyRequests, "too many failed authorization attempts")
				return
			}
			token, ok := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
			if !ok {
				limiter.fail(ip)
				writeError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			u, err := svc.Authenticate(r.Context(), token)
			if errors.Is(err, models.ErrUnauthorized) {
				limiter.fail(ip)
				writeError(w, http.StatusUnauthorized, "unauthorized")
				return
			}
			if err != nil {
				writeErr(w, r, err)
				return
			}
			if info, ok := r.Context().Value(infoKey{}).(*reqInfo); ok {
				info.user = u.Name
			}
			next.ServeHTTP(w, r.WithContext(context.WithValue(r.Context(), userKey{}, u)))
		})
	}
}

// clientIP is the TCP peer address. Forwarded headers are not trusted: the server is not behind a proxy.
func clientIP(r *http.Request) string {
	host, _, err := net.SplitHostPort(r.RemoteAddr)
	if err != nil {
		return r.RemoteAddr
	}
	return host
}

// authLimiter counts 401 responses per IP in fixed windows that start at the first failure.
// Unlike generic rate limiters, it counts only failed authorizations, not all requests.
type authLimiter struct {
	mu     sync.Mutex
	limit  int
	window time.Duration
	now    func() time.Time
	ips    map[string]*failWindow
}

type failWindow struct {
	start time.Time
	count int
}

func newAuthLimiter(limit int, window time.Duration) *authLimiter {
	return &authLimiter{limit: limit, window: window, now: time.Now, ips: map[string]*failWindow{}}
}

func (l *authLimiter) current(ip string, now time.Time) *failWindow {
	fw := l.ips[ip]
	if fw != nil && now.Sub(fw.start) >= l.window {
		delete(l.ips, ip)
		return nil
	}
	return fw
}

func (l *authLimiter) blocked(ip string) bool {
	l.mu.Lock()
	defer l.mu.Unlock()
	fw := l.current(ip, l.now())
	return fw != nil && fw.count >= l.limit
}

func (l *authLimiter) fail(ip string) {
	l.mu.Lock()
	defer l.mu.Unlock()
	now := l.now()
	// Drop expired windows now and then so that the map stays small.
	if len(l.ips) > 1000 {
		for k, fw := range l.ips {
			if now.Sub(fw.start) >= l.window {
				delete(l.ips, k)
			}
		}
	}
	fw := l.current(ip, now)
	if fw == nil {
		fw = &failWindow{start: now}
		l.ips[ip] = fw
	}
	fw.count++
}
