# vibe-memory

PWA для iPhone (`pwa-mobile-client/`) и домашний сервер на Go (`server/`). Docker-образ один: сервер сам раздаёт
приложение и API с одного адреса. Поэтому CORS не нужен, и в настройках приложения адрес сервера уже
подставлен.

Подробности по частям: [web/README.md](web/README.md) и [backend/README.md](backend/README.md).

## Команды

Все команды запускаются из корня репозитория. Настройки лежат в `.env` в корне, он создаётся из `.env.example`
при первом запуске. Относительный `DATA_DIR` считается от `server/`: по умолчанию данные лежат в `server/data`.

```sh
make backend             # бэк на :8080, на переднем плане
make web                 # фронт на :5173, на переднем плане
make up                  # бэк и фронт в фоне, логи в .run/backend.log и .run/web.log
make down                # остановить то, что запустил up
make user-add NAME=anna  # добавить пользователя, печатает токен
```

Значение из командной строки важнее `.env`, например `make backend ADDR=:9000`.
Список пользователей: `cd server && go run ./cmd/api user list`.

Запуск в Docker рядом с кодом: база и фото попадут в `./data`, рядом с `Dockerfile`.

```sh
mkdir -p data && sudo chown 65532:65532 data   # только на Linux: процесс в контейнере работает от uid 65532
docker compose up -d --build
docker compose exec vibe-memory /vibe-memory user add anna
```

Переменные окружения описаны в [backend/README.md](backend/README.md#конфигурация).
`ALLOWED_ORIGINS` в образе пустая: приложение и API работают с одного адреса.

## Пользователи и токены

У каждого человека свой аккаунт и свой токен. Фото разных аккаунтов не смешиваются.
Токен — это случайный UUID. Приложение отправляет его в заголовке `Authorization: Bearer <токен>`.

Добавить пользователя (сервер может работать):

```sh
docker compose exec vibe-memory /vibe-memory user add anna
# 3f0c2b1e-8a4d-4c6b-9f1e-2d7a5b9c0e14   <- токен
```

Список пользователей с токенами, если кто-то потерял свой:

```sh
docker compose exec vibe-memory /vibe-memory user list
```