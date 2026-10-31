include .env
export

.PHONY: backend web up down user-add

backend:  # бэк на переднем плане
	cd server && go run ./cmd/api

web:  # фронт на переднем плане
	cd pwa-mobile-client && npm run dev

up:  # бэк и фронт в фоне, логи в .run/
	mkdir -p .run
	cd server && go build -o bin/vibe-memory ./cmd/api
	(cd server && exec bin/vibe-memory) > .run/backend.log 2>&1 & echo $$! > .run/backend.pid
	(cd pwa-mobile-client && exec node_modules/.bin/vite) > .run/web.log 2>&1 & echo $$! > .run/web.pid

down:  # остановить то, что запустил up
	-kill $$(cat .run/*.pid 2>/dev/null) 2>/dev/null
	rm -f .run/*.pid

user-add:  # make user-add NAME=anna, печатает токен
	@test -n "$(NAME)" || (echo "укажите NAME=..." && exit 1)
	@cd server && go run ./cmd/api user add "$(NAME)"

.env:
	cp .env.example .env
