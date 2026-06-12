# undercast

**Самоосознающий оверлей для OBS.** Бегущая строка, которая слушает эфир и ведёт себя сама.

> English version: [README.md](README.md)

undercast — локальный оверлей-сервер для OBS с новостной строкой внизу кадра. Необычное в нём то, что он знает, что происходит в эфире: companion-демон читает живой транскрипт стрима и строит план эфира по ходу разговора — пройденные этапы ✓, текущий ▶, — а chat-демон печатает сообщения YouTube live-чата прямо в строку.

![режим план](https://raw.githubusercontent.com/serejaris/undercast/main/docs/img/ticker-plan.png)

![режим сообщения](https://raw.githubusercontent.com/serejaris/undercast/main/docs/img/ticker-message.png)

## Возможности

- **Самопишущийся план стрима** — этапы определяются из живого транскрипта и добавляются сами; по каждому копятся таймстемпы входа/выхода, после эфира экспортируются готовые YouTube-таймкоды
- **Живой чат в строке** — сообщения YouTube live-чата (и свежие комментарии под анонс-видео) печатаются посимвольно, по одному, затем возвращается план
- **Событийные режимы** — план это фон; сообщение зрителя перебивает его, очередь опустошается, план возвращается; ручной выключатель возвращает классическую плоскую ленту
- **Полноэкранные заставки** — отсчёт до старта, «мы вернёмся», финал, временная вспышка со scramble-анимацией
- **Промпт-виджет** — lower-third с последним промптом, отправленным вашему кодинг-агенту
- **OBS-тулинг** — добавление сорсов, скриншоты, любой запрос obs-websocket v5 из CLI
- Ноль зависимостей: один Node-сервер, состояние через SSE, простые HTML-оверлеи

## Быстрый старт

```bash
npm install -g undercast
undercast serve                 # http://127.0.0.1:8722
```

В OBS: источник **Browser**, URL `http://127.0.0.1:8722/ticker`, ширина `1920`, высота `64`, поставить внизу сцены. Фон страницы прозрачный — видна только плашка. Или пусть undercast сделает это сам через obs-websocket:

```bash
undercast obs add-ticker        # добавит browser-сорс в текущую сцену
```

Превью в обычном браузере: `http://127.0.0.1:8722/ticker?demo=1` (тёмный фон вместо прозрачного).

Дальше:

```bash
undercast ticker now "собираем оверлей"           # зелёный слот «сейчас»
undercast ticker chat "что за шрифт?" alex        # вопрос зрителя
undercast ticker mode plan                        # режим план: этапы + сейчас; сообщения перебивают
undercast plan export chapters                    # YouTube-таймкоды после эфира
```

## CLI

Один entrypoint — `undercast <команда>`:

| Команда | Что делает |
|---|---|
| `serve` | оверлей-сервер (foreground); `serve start\|stop\|status` — демоном |
| `ticker now\|news\|chat\|set\|add\|clear\|mode\|speed\|hide\|show\|status` | управление строкой |
| `plan show\|append\|export\|clear` | план стрима как авто-история (`set` остался как debug) |
| `screen start\|brb\|end\|flash\|off` | полноэкранные заставки |
| `companion start\|stop\|status\|once` | наблюдатель транскрипта: авто-план + слот «сейчас» (опционален, см. ниже) |
| `chatfeed start\|stop\|status\|once\|smoke` | поллер YouTube-чата |
| `obs add-ticker\|add-screens\|req\|screenshot` | OBS-помощники через obs-websocket v5 |

## Конфигурация

Порядок разрешения: флаг CLI > переменная окружения > `undercast.config.json` в рабочей директории > дефолт.

| Env | Дефолт | Смысл |
|---|---|---|
| `UNDERCAST_PORT` | `8722` | порт оверлей-сервера |
| `UNDERCAST_URL` | `http://127.0.0.1:8722` | базовый URL для CLI-клиентов (`TICKER_URL` тоже работает) |
| `UNDERCAST_CHANNEL` | — | YouTube-хэндл, например `@yourname`; нужен chatfeed'у |
| `UNDERCAST_YT_TOKEN` | `~/.config/youtubeuploader/yt_token.json` | файл OAuth-токена YouTube Data API |
| `UNDERCAST_STATE_DIR` | `~/.local/state/undercast` | состояние, pid-файлы и логи |

`undercast.config.json`:

```json
{ "port": 8722, "channel": "@yourname", "ytToken": "~/.config/youtubeuploader/yt_token.json", "stateDir": "~/.local/state/undercast" }
```

## Режимы строки

| Режим | Что на экране |
|---|---|
| `plan` | фон: этапы плана ✓/▶ + слот «сейчас»; слева вне скролла статичный чип режима |
| `message` | сообщение зрителя перебивает: скролл останавливается, «автор: текст» печатается посимвольно, висит ~8 с, затем возвращается план |
| `off` | классическая плоская лента всех каналов (по умолчанию) |

Сообщения идут через FIFO-очередь на сервере (cap 10, старейшие дропаются), каждое показывается ровно один раз, очередь переживает рестарт. В режиме `off` `POST /chat` работает по-старому — пунктом в ленту.

Плоская лента собирается из типизированных пунктов, у каждого свой чип: `now` (зелёный, один слот, replace), `news` (голубой, хранятся последние 5), `chat` (янтарный, последние 5), `note` (без чипа).

## Companion (опционален)

`undercast companion` — то, что делает оверлей самоосознающим, и он честен о своих зависимостях: вызывает CLI [Claude Code](https://claude.com/claude-code) (`claude -p`, по умолчанию haiku) с официальным [Granola MCP](https://docs.granola.ai/help-center/sharing/integrations/mcp), который транскрибирует стрим-сессию как встречу. Каждый цикл (180 с, меняется через `COMPANION_INTERVAL`) он читает последние минуты живого транскрипта и решает:

- начался ли **новый этап** разговора? → добавить в план (`POST /plan/append`) + полноэкранная вспышка
- что мы делаем **прямо сейчас**? → обновить слот «сейчас»

Нет Claude Code или Granola — нет companion; всё остальное работает без него. План можно вести и руками (`undercast plan append "новый этап"`).

После эфира `undercast plan export chapters` печатает YouTube-таймкоды из накопленных таймстемпов этапов; `export md` — чеклист с интервалами. Демоны запускайте в начале эфира — план покрывает только то, что companion видел.

## chatfeed: YouTube-чат → строка

`undercast chatfeed start` поллит live-чат текущего эфира — видео резолвится само через `youtube.com/<канал>/live` (без расхода квоты API), настраивать перед каждым стримом нечего. `chatfeed start <url-анонса>` дополнительно поллит свежие комментарии под анонс-видео (только написанные после старта демона).

Перед строкой сообщения проходят эвристические фильтры: URL вырезаются, тексты длиннее 200 символов пропускаются, не-текстовые события (стикеры, суперчаты) пропускаются, дубли отбрасываются по id (seen-set переживает рестарты). Никакого LLM в горячем пути.

Авторизация: OAuth-токен YouTube Data API в формате [youtubeuploader](https://github.com/porjo/youtubeuploader) (`UNDERCAST_YT_TOKEN`). Scope `youtube.force-ssl` покрывает и чат, и комментарии. До старта эфира демон спокойно ждёт, перепроверяя каждые 2 минуты; после конца чата снова ищет лайв.

## Заставки и промпт-виджет

`/screens` — полноэкранная страница, которая висит в сцене постоянно (прозрачна в режиме off, мгновенное переключение, без смены сцен):

```bash
undercast screen start "О чём стрим" 10        # отсчёт, 10 минут
undercast screen brb "чай и обратно"           # таймер паузы
undercast screen end "запись скоро на канале"  # финал с CTA
undercast screen flash "сменили тему" 8        # вспышка, гаснет сама
undercast screen off
```

`/prompt-widget` — lower-third с последним промптом вашему кодинг-агенту, с анимацией набора, гаснет через 20 с (`?ttl=30` — другое время). Подача руками (`curl -X POST localhost:8722/prompt -d '{"text":"..."}'`) или автоматически из Claude Code хуком `UserPromptSubmit`, вызывающим `scripts/hooks/prompt-to-overlay.sh`.

## HTTP API

| Endpoint | Что делает |
|---|---|
| `GET /ticker` | страница оверлея |
| `GET /state` | текущее состояние JSON |
| `GET /events` | SSE-поток обновлений состояния |
| `GET /prompt-widget` | страница промпт-виджета |
| `GET /prompt` | последний промпт JSON (`{text, ts}`) |
| `GET /prompt-events` | SSE-поток промптов (replay последнего с его `ts`) |
| `POST /prompt` | `{"text": "..."}` — показать промпт; пустой text прячет плашку |
| `POST /now` | `{"text": "..."}` — заменить слот «сейчас»; пустой text убирает |
| `POST /news` | `{"text": "..."}` — добавить новость |
| `POST /chat` | `{"text": "...", "author": "..."}` — сообщение зрителя: в режимах — в очередь показа, при `off` — пунктом в ленту |
| `POST /mode` | `{"mode": "plan\|off"}` — переключить режим строки |
| `GET /screens` | страница заставок |
| `POST /plan` | `{"steps": [...]}` — задать план (пустой массив убирает) |
| `POST /plan/current` | `{"index": N}` — прыгнуть на шаг N (0-based; предыдущие → done) |
| `POST /plan/done` | завершить текущий шаг, следующий → текущий |
| `POST /plan/append` | `{"text": "..."}` — новый этап: текущий → done, новый → current |
| `GET /plan/export` | `?format=chapters\|md` — таймкоды или чеклист |
| `POST /screen` | `{"mode": "off\|start\|brb\|end\|flash", "title", "sub", "minutes", "seconds"}` |
| `POST /set` | `{"items": [{"type","text"}, ...]}` или строки — полная замена |
| `POST /add` | `{"text": "...", "type": "note"}` — append |
| `POST /clear` | `{}` всё или `{"type": "news"}` один тип |
| `POST /config` | `{"speed", "visible"}` |

Состояние переживает рестарт сервера (`state.json` в `UNDERCAST_STATE_DIR`).

## Лицензия

MIT
