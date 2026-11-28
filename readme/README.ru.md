<p align="center">
  <img
    src="https://raw.githubusercontent.com/AquilaXk/easyproxy/main/desktop/src-tauri/icons/icon.png"
    width="80"
    alt="EasyProxy"
  >
</p>

<h1 align="center">EasyProxy</h1>

<p align="center">
  Единый локальный шлюз для ваших инструментов программирования с ИИ и моделей.
  <br>
  Используйте выбранные модели с Codex, Claude Code, Claude Desktop и Grok Build или подключайте OpenCode, Pi, Qoder, WorkBuddy, Kilo, Cline, T3 Code и другие через управляемые конфигурации.
  <br>
  <a href="#quick-start"><b>Установить ↓</b></a> · <a href="https://easyproxy.me/ru/reference/client-support/"><b>Поддерживаемые инструменты →</b></a>
</p>

<p align="center">
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-windows-x64.msi"><img src="../assets/download-windows.svg" alt="Скачать для Windows (.msi)" height="48"></a>
  &nbsp;
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-macos-arm64.dmg"><img src="../assets/download-macos.svg" alt="Скачать для macOS Apple Silicon (.dmg)" height="48"></a>
  &nbsp;
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-linux-x86_64.AppImage"><img src="../assets/download-linux.svg" alt="Скачать для Linux (.AppImage)" height="48"></a>
  <br>
  <sub>Кнопка macOS предназначена для Apple Silicon (arm64). <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-macos-x64.dmg">macOS Intel (.dmg)</a> · <a href="https://github.com/AquilaXk/easyproxy/releases/latest/download/EasyProxy-linux-amd64.deb">Linux (.deb)</a> · <a href="https://github.com/AquilaXk/easyproxy/releases/latest">Все файлы и контрольные суммы</a></sub>
</p>

<p align="center">
  <a href="https://github.com/AquilaXk/easyproxy/actions/workflows/ci.yml"><img alt="CI" src="https://github.com/AquilaXk/easyproxy/actions/workflows/ci.yml/badge.svg?branch=main&style=flat-square"></a>
  <a href="https://github.com/AquilaXk/easyproxy/releases/latest"><img alt="Release" src="https://img.shields.io/github/v/release/AquilaXk/easyproxy?style=flat-square"></a>
  <a href="https://www.npmjs.com/package/easyproxy"><img alt="npm" src="https://img.shields.io/npm/v/easyproxy?style=flat-square"></a>
  <a href="https://github.com/AquilaXk/easyproxy/blob/main/LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-blue?style=flat-square"></a>
  <a href="https://github.com/sponsors/AquilaXk"><img alt="GitHub Sponsors" src="https://img.shields.io/github/sponsors/AquilaXk?style=flat-square&logo=githubsponsors&label=Sponsors"></a>
</p>

<p align="center">
  <a href="../README.md">English</a> · <a href="README.fr.md">Français</a> · <a href="README.ko.md">한국어</a> · <a href="README.zh-CN.md">简体中文</a> · <a href="README.zh-TW.md">繁體中文</a> · <b>Русский</b> · <a href="README.ja.md">日本語</a> · <a href="README.tr.md">Türkçe</a> · 📖 <a href="https://easyproxy.me/ru/"><b>Полная документация →</b></a>
</p>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start
```

<table>
<tr>
<td width="50%" valign="middle">

### Claude Code на любой модели

Селектор остаётся штатным Claude Code, а модель за ним выбираете вы.

</td>
<td width="50%">
  <img src="../assets/claude-code-models.gif" alt="Claude Code работает на маршрутизированной модели через easyproxy (в строке состояния активна gpt-5.6-luna-medium)" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Codex на любой модели

Выберите провайдера и сохраните привычный рабочий процесс.

</td>
<td width="50%">
  <img src="../assets/demo.gif" alt="Демонстрация easyproxy: выполнение задачи в приложении Codex на маршрутизированной модели не от OpenAI" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Claude Desktop на любой модели

Opus отвечает, затем передаёт задачу подагенту GPT-5.6 Sol.

</td>
<td width="50%">
  <img src="../assets/claude-desktop-subagent.gif" alt="Claude Desktop отвечает как Claude Opus 4.8, затем запускает подагента GPT-5.6 Sol через easyproxy" width="100%">
</td>
</tr>
<tr>
<td width="50%" valign="middle">

### Grok Build на любой модели

Sol ведёт сессию и вызывает подагента Kimi K3.

</td>
<td width="50%">
  <img src="../assets/grok-build-subagent.gif" alt="Grok Build запускает GPT-5.6 Sol через easyproxy и вызывает подагента Kimi K3" width="100%">
</td>
</tr>
</table>

easyproxy — лёгкий локальный шлюз между вашими инструментами программирования и поставщиками моделей. Он принимает запросы API Responses, Chat Completions и Anthropic Messages и переводит их в протокол провайдера, передавая потоковые ответы, вызовы инструментов, рассуждения и изображения там, где это поддерживают клиент, модель и провайдер. Используйте Claude, Gemini, Grok, GLM, DeepSeek, Kimi, Qwen, Ollama и других провайдеров с Codex, Claude Code, Claude Desktop, Grok Build и инструментами со [страницы поддержки клиентов](https://easyproxy.me/ru/reference/client-support/).

## Основные возможности

- **Любая LLM в Codex, Claude Code, Claude Desktop и Grok Build.** Более 40 встроенных провайдеров, каждый со своим нативным UI.
- **Combos.** Один виртуальный id модели с failover или взвешенным round-robin между провайдерами. См. [руководство по combos](https://easyproxy.me/ru/guides/combos/).
- **Подагенты на любой модели.** Выводите маршрутизируемые модели в селектор подагентов Codex с управлением поверхностями v1/v2 и цепочками fallback. См. [руководство по подагентам](https://easyproxy.me/ru/guides/sub-agent-surface/).
- **Один вход или API-ключ.** OAuth для xAI, Anthropic и Kimi; проброс `codex login`; вставка ключа или ссылки `${ENV_VAR}`.
- **Сайдкары веб-поиска и зрения.** Модели не от OpenAI получают настоящий веб-поиск и понимание изображений через сайдкар поверх вашего входа ChatGPT.
- **Живая панель и журнал.** Панель показывает провайдеров, статус OAuth, выбор моделей и живой журнал запросов с количеством токенов кэша.
- **Чистый выход.** `epx stop` возвращает Codex к исходной конфигурации.
- **Ограниченное владение памятью.** У каждого долгоживущего кэша, кольцевого буфера и хранилища трансляции протокола есть конечный потолок, байтовый бюджет или активная сверка. Ни один неограниченный `Map` или `Set` не переживает перезагрузку конфигурации.

<details>
<summary>Подробности владения памятью</summary>

EasyProxy отслеживает состояние, удерживаемое процессом, в категориях ниже. У каждой есть
документированная граница:

- **15 удерживаемых хранилищ** (журнал запросов, отладочные кольца, кэш изображений, кэш
  моделей, vision-описания, cursor-блобы, продолжение responses и т. д.) учитываются
  в байтах и вытесняются бюджетом памяти приложения (по умолчанию 256 MiB), кроме
  хранилища native control replay: оно закреплено и не вытесняется.
- **4 наблюдаемых буфера** (аккумуляторы транслятора, хвосты image/OAuth/Grok)
  мониторятся по байтовому давлению in-flight без вытеснения.
- **32 регистрации state-store** выполняет sweeps истечения (интервал 60 с) и сверку
  поколений конфигурации, чтобы удалять устаревшие ключи провайдеров и аккаунтов.
- **Мемо пути и отпечатков** (метаданные рабочей области, усиленные идентификаторы,
  соли установки, возможности mode-hint) используют LRU-потолки в порядке вставки
  (8–128 записей).
- **Tombstone поколений кэша моделей** удаляются после сверки; глобальный инкремент
  поколения не даёт устаревшим in-flight discovery снова заполнить удалённых провайдеров.
- **Дедупликация event-id в Lab** работает под блокировкой журнала с диска, без
  процессного RAM-индекса.

Выполните `GET /api/system/memory` (с admin-токеном), чтобы посмотреть живые удержанные
байты, счётчики вытеснения и выборки watchdog.

</details>

<a id="quick-start"></a>

## Быстрый старт

### Личная установка (CLI)

```bash
npm install -g --allow-scripts=bun easyproxy   # Node 18+; рантайм Bun подключается автоматически
epx start                         # прокси + панель управления на localhost:10100
```

Чтобы запустить его в фоне, используйте `epx service`.

Откройте **http://localhost:10100** и настройте всё в веб-панели: добавьте провайдеров
(40+ встроенных или любой OpenAI-совместимый endpoint), выберите модели и управляйте
аккаунтами. `epx gui` в любой момент снова откроет панель.

### Подключите свой инструмент

Подключите инструмент, которым вы уже пользуетесь:

| Инструмент | Как подключить |
|---|---|
| Codex | Включите переключатель Codex на странице **Route** панели, затем запускайте `codex` как обычно. При локальном прослушивании встроенный провайдер Codex будет направлен на прокси. В терминале выполните `epx init` до добавления провайдеров в панели и примите приглашение Codex. |
| Claude Code | Установив CLI `claude`, выполните `epx claude`. Команда при необходимости запускает прокси и запускает через него Claude Code. |
| Claude Desktop | Выполните `epx claude desktop`. При новой установке команда настраивает профиль шлюза для всего приложения; существующая настройка first-party сохраняется, а `epx claude desktop apply --gateway` явно переключает режим. См. [руководство Claude Code](https://easyproxy.me/ru/guides/claude-code/). После переключения полностью закройте и снова откройте Claude Desktop. |
| Grok Build | При локальном прослушивании и включённой интеграции Grok команда `epx start` регистрирует модели, если существует `~/.grok`; выберите модель `epx-*` в Grok Build. Об удалённой настройке см. [руководство Grok Build](https://easyproxy.me/ru/guides/grok-build/). После добавления провайдеров перезапустите прокси (или выполните `epx ensure`, если включён автозапуск Codex), чтобы обновить список. |
| Инструменты с управляемой интеграцией | Используйте страницу **Route** панели или `epx integration client enable --client <id>`. |
| Любой другой инструмент | Укажите пользовательский базовый URL, совместимый с OpenAI: `http://localhost:10100/v1`, либо базовый URL Anthropic: `http://localhost:10100`. |

На [странице поддержки клиентов](https://easyproxy.me/ru/reference/client-support/) указаны способы подключения и протоколы каждого инструмента.

<details>
<summary><b>Настольное приложение (бета)</b></summary>

Настольное приложение объединяет тот же прокси и панель управления в нативном окне с иконкой в трее и встроенным `epx`. Оно подключается к уже запущенному прокси либо запускает встроенный, а панель остаётся на порту прокси (**http://localhost:10100**, если вы не настроили другой). Выберите файл для своей платформы в [последнем релизе](https://github.com/AquilaXk/easyproxy/releases/latest):

| Платформа | Файл | Примечания |
|---|---|---|
| macOS 14+ (Apple Silicon) | `EasyProxy-<version>-macos-arm64.dmg` | Подписана Developer ID и нотариализована при наличии учётных данных Apple; без них остаётся неподписанной (в Gatekeeper выберите **ПКМ → Открыть**) |
| macOS 14+ (Intel) | `EasyProxy-<version>-macos-x64.dmg` | Отдельная сборка для Intel x64; те же требования Gatekeeper при отсутствии подписи |
| Windows (x64) | `EasyProxy-<version>-windows-x64.msi` | Подпись кода через SignPath Foundation внедряется ([политика подписи кода](https://easyproxy.me/ru/reference/code-signing/)); пока релиз не подписан, SmartScreen спросит один раз: выберите **Подробнее → Выполнить в любом случае** |
| Linux (x86_64) | `EasyProxy-<version>-linux-x86_64.AppImage` или `-linux-amd64.deb` | Для трея нужен рабочий стол с поддержкой AppIndicator |

Рядом с каждым файлом на странице релиза есть `.sha256`, а имена установщиков без версии (`EasyProxy-macos-arm64.dmg`, `EasyProxy-macos-x64.dmg`, `EasyProxy-windows-x64.msi`, `EasyProxy-linux-x86_64.AppImage`, `EasyProxy-linux-amd64.deb`) в `/releases/latest` ведут на те же проверенные сборки. На macOS 14+ приложение также
поставляется с расширением WidgetKit, которое показывает состояние прокси, расход за
сегодня и квоты провайдеров; модель снимков, которую оно отображает, находится в
[`app/`](../app) (`MenuBarCore`). Чтобы собрать приложение самостоятельно, выполните
`bun install && bun run build:gui` в корне репозитория, затем в `desktop/` выполните
`bun install && bun run prepare-sidecar && bun run prepare-widget && bun run build:local` на macOS
или `bun install && bun run prepare-sidecar && bun run build:local` на Windows и Linux (шаг с виджетом
работает только на macOS). В [руководстве по настольному приложению](https://easyproxy.me/ru/guides/desktop-app/) и
[руководстве по приложению macOS в строке меню](https://easyproxy.me/ru/guides/macos-menu-bar/)
описан первый запуск, а
[`CLI_CONSENT.md`](../CLI_CONSENT.md#where-things-are-installed) перечисляет всё, что записывается на диск.

</details>

<details>
<summary><b>Поддерживаемые платформы</b></summary>

| ОС | Статус | Менеджер служб | Настольное приложение (бета) |
|---|---|---|---|
| macOS (arm64 / x64) | Полная поддержка | launchd | `arm64` / `x64` `.dmg` |
| Linux (x64 / arm64) | Полная поддержка | systemd (пользовательский unit) | `.AppImage` / `.deb` для x86_64 |
| Windows (x64) | Полная поддержка | Task Scheduler (скрыто) / опциональная нативная служба (`--native`, WinSW) | `.msi` для x64 |

Для установки CLI требуется [Node](https://nodejs.org) 18+; настольному приложению не нужны ни Node, ни Bun. Рантайм Bun добавляется автоматически при `npm install`, поэтому отдельно устанавливать Bun не нужно, а на Windows не нужен WSL. Если npm заблокировал скрипты установки встроенного рантайма, см. [документацию по установке](https://easyproxy.me/ru/getting-started/installation/).

</details>

<details>
<summary><b>Docker Compose</b></summary>

Репозиторий поставляет сборку Compose с закреплённым дайджестом и без root. Сборка сама создаёт
и проверяет канонический манифест совместимости из выбранного снимка Git. Для локального клона
нужны Git и Docker Compose, для удалённого Git-контекста нужен Docker Compose. Ни одному варианту
не нужны Bun на хосте или подготовительный шаг. Один раз инициализируйте токен плоскости данных
через stdin и запустите хаб:

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
docker compose build
openssl rand -hex 32 | docker compose run --rm -T hub bun run docker/bootstrap-token.ts
docker compose up -d
curl --fail --silent http://127.0.0.1:10100/healthz
curl --fail --silent http://127.0.0.1:10100/readyz
```

Привязка по умолчанию: `127.0.0.1:10100`. Удалённый доступ требует явного
`EASYPROXY_BIND_ADDRESS=<LAN-or-Tailscale-IP> docker compose up -d`; `0.0.0.0` открывает
все интерфейсы хоста. Ограничьте доступ файрволом и аутентифицированным TLS/tailnet-фронтендом.
Сгенерированный JSON остаётся неотслеживаемым. В контекст сборки допускаются только `.git/index`
и `.git/HEAD` (инвентарь, который читает `git ls-files`, объёмом около 1 МБ вместо полного хранилища
объектов). Они видны только этапу манифеста, используемому при сборке, через монтирование только для
чтения, поэтому ни один `COPY` не включает `.git`. Манифест, ранее созданный на хосте, принимается
только после проверки; иначе сборка создаёт его сама. Сборка отклоняет устаревшие манифесты,
отсутствующие или несовпадающие файлы, лишние исходники
и символические ссылки. Она сверяет каждый записанный SHA-256 с контекстом сборки и скопированными
рантайм-файлами, включая `package.json`, `bun.lock` и явно включённый
`scripts/model-metadata.source.json`.

Для удалённого Git-контекста BuildKit должен сохранять метаданные Git. Этот фрагмент сборки Compose
выбирает удалённый снимок и передаёт требуемый встроенный аргумент:

```yaml
services:
  hub:
    pull_policy: build
    build:
      context: https://github.com/AquilaXk/easyproxy.git#main
      dockerfile: Dockerfile
      target: runtime
      args:
        BUILDKIT_CONTEXT_KEEP_GIT_DIR: "1"
```

Токен и изменяемое состояние живут в именованном томе `epx-state`; ни одно учётное данное не
попадает в образ, Compose-файл, окружение или аргументы оболочки. См.
[руководство по развёртыванию Remote Hub](https://easyproxy.me/ru/guides/remote-hub/)
для настройки провайдеров, аутентифицированных проверок приёмки, удалённого управления и отката.

</details>

<details>
<summary><b>Установка из исходников (последний main)</b></summary>

**macOS / Linux:**

```bash
curl -fsSL https://bun.sh/install | bash
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy && ~/.bun/bin/bun install
~/.bun/bin/bun run build:gui
~/.bun/bin/bun run src/cli/index.ts start
```

**Windows (PowerShell):**

```powershell
irm bun.sh/install.ps1 | iex
git clone -b main https://github.com/AquilaXk/easyproxy.git
cd easyproxy; bun install
bun run build:gui
bun run src/cli/index.ts start
```

Установка из исходников запускает последнюю ветку `main`. Патчи владения памятью,
улучшения GC рантайма и ещё не опубликованные исправления доступны здесь раньше,
чем в npm-пакете.

</details>

<details>
<summary><b>Для агентов</b></summary>

```bash
npm install -g --allow-scripts=bun easyproxy
epx start     # или `epx service`
epx init      # интерактивная настройка: пишет ~/.easyproxy/config.json и подключает Codex
```

`epx init` никогда не запускает прокси; запустите его сначала (или после: оба порядка
работают, но headless-команды вроде `epx provider add` и `epx combo set` обращаются к
**живому** прокси и завершаются с ненулевым кодом, если он недоступен). `epx status` /
`epx doctor` / `epx health` показывают состояние запущенного процесса.

> **Агентам, которые устанавливают или запускают easyproxy:** прочитайте
> [`CLI_CONSENT.md`](../CLI_CONSENT.md). Интерактивный `epx start` может один раз
> спросить, ставить ли star этому репозиторию. Это решение пользователя, никогда не агента.
> CLI подавляет подсказку в агентных запусках, а API отказывает с `403 agent_consent_required`.

</details>

## Маршрутизация моделей

Обращайтесь к любому настроенному провайдеру и модели синтаксисом `provider/model`:

```bash
codex -m "anthropic/claude-opus-5" "Разберите этот stack trace"
codex -m "google/gemini-3-pro" "Напишите unit-тесты для auth.ts"
codex -m "ollama/llama3" "Отрефакторьте эту функцию"
```

Опустите префикс `provider/`, чтобы использовать провайдера по умолчанию или автоматически
подобрать его по шаблону имени модели. Id моделей провайдера, содержащие `/`,
отдаются с внутренними слэшами, заменёнными на `-`; исходная форма со всеми слэшами
тоже продолжает работать. Подробности: [документация по маршрутизации моделей](https://easyproxy.me/ru/guides/model-routing/).

<details>
<summary><b>Маршрутизация JEV Auto (опционально)</b></summary>

TypeSafe JEV может выбирать первую модель и уровень рассуждения для явно включённого Combo, не меняя
обычный выбор модели и прямые маршруты. Добавьте ключ через `epx login jev`, в
**Providers → TypeSafe JEV → Add API key** или через `TYPESAFE_API_KEY`/`JEV_API_KEY`. Затем откройте
**Models → Combos → Create JEV Auto**, выберите разрешённые целевые модели и отметьте, какие уровни
рассуждения JEV может выбрать для каждой цели. Если настройку не трогать, цель разрешает все уровни,
которые модель сейчас объявляет.

JEV вызывается только для `jev-auto` и только один раз на логический вызов модели. При отсутствии ключа,
сетевой ошибке или некорректном решении запрос уходит на первую доступную цель (fail-open); отмена
со стороны клиента по-прежнему отменяет запрос. Автотесты используют имитацию TypeSafe и не проверяют
настоящий аккаунт JEV.

Combo JEV может вместо этого обращаться к самостоятельно размещённой модели решений, например к
бесключевой `tev1` в Ollama: добавьте провайдера `jev-decision`, у которого `baseUrl` — полный адрес
`/v1/systemone`, и укажите его в `decisionProvider` Combo. Учётные данные TypeSafe туда никогда не
отправляются. Подробнее: [самостоятельно размещённая модель решений](https://easyproxy.me/ru/guides/combos/).

</details>

## Провайдеры и адаптеры

OpenAI (вход ChatGPT или API-ключ), Anthropic, Google Gemini, xAI, Kimi, Azure OpenAI, Ollama
(локально + Cloud), Cursor (экспериментально) и любой OpenAI-совместимый endpoint, а также DeepSeek,
Groq, OpenRouter, OpenGateway, Together, Fireworks, Cerebras, Mistral, Hugging Face, NVIDIA NIM, MiniMax,
Qwen Cloud, Qoder Global и CN (официальный PAT + CLI), SiliconFlow и другие. Полный список: `epx init` или
[документация по провайдерам](https://easyproxy.me/ru/guides/providers/).

## CLI

```bash
epx init                       # интерактивная настройка (пишет конфиг, подключает Codex, предлагает shim)
epx start [--port 10100] [--socks5 [host:port] | --socks5-off]  # SOCKS5 по умолчанию: socks5://127.0.0.1:10808
epx stop                       # остановить + восстановить нативный Codex
epx service [install|repair|restart|start|stop|status|uninstall|remove]  # фоновая служба
epx codex-shim install         # запускать прокси по требованию при старте `codex`
epx health [--json]            # проверить немедленную живость прокси
epx ready [--json] [--wait [--timeout <seconds>]]  # проверить готовность после синхронизации
epx status                     # работает ли прокси?
epx gui                        # открыть веб-панель
epx provider <...>             # управлять провайдерами (list/add/edit/test/remove)
epx account <...>              # управлять аккаунтами ChatGPT и пулами API-ключей
epx combo <...>                # управлять combos с failover / round-robin
epx v2 <...>                   # управление мультиагентными поверхностями v1/v2
epx update [--tag preview]     # обновить easyproxy
```

Если предпочтительный порт занят, запуск останавливается и сообщает, какой процесс его занимает, вместо перехода
на другой порт, поэтому второй прокси никогда не останется работать рядом с первым. Освободите порт или укажите
другой с помощью `--port`. Полный справочник: [документация CLI](https://easyproxy.me/ru/reference/cli/).

<details>
<summary><b>Здоровье и готовность</b></summary>

`GET /healthz` сообщает о немедленной живости прокси. Неаутентифицированный endpoint `GET /readyz`
сообщает о готовности после синхронизации с очищенной JSON-идентичностью `{service, version, uptime, pid, port, status}`.
Он возвращает `200`, когда `status` равен `ready`; `pending` и терминальный `failed` возвращают `503` с
`Retry-After: 1`.

`epx ready [--json] [--wait [--timeout <seconds>]]` по умолчанию выполняет один зонд. `--wait` опрашивает
до 45 секунд по умолчанию, но сразу завершается при терминальном `failed`;
`--timeout <seconds>` задаёт лимит 1–300 секунд, требует `--wait` и принимает только положительные целые. CLI `--json` выводит
`{ready, status, pid, port}`, где `status` равен `ready`, `pending`, `failed` или `unreachable`.

| Код | Результат |
| --- | --- |
| `0` | Готов |
| `1` | Не готов: pending, failed, timeout или unreachable |
| `64` | Некорректные аргументы |

Старый прокси без `/readyz` закрывается как `unreachable` с кодом 1, тогда как `epx health`
остаётся совместимым.

</details>

### Автозапуск: служба или shim

Используйте **службу** (`epx service`) для постоянно работающего прокси, который перезапускается
при сбое. Используйте **shim** (`epx codex-shim install`) для лёгкого запуска по требованию без
фонового демона. Удаляйте их командами `epx service uninstall` / `epx codex-shim uninstall`.

### Удаление

```bash
epx uninstall                  # остановить, удалить службу/shim, восстановить нативный Codex, очистить состояние
npm uninstall -g easyproxy
```

## Удалённый доступ

По умолчанию easyproxy привязывается к `127.0.0.1` и не требует дополнительной аутентификации.
Привязка за пределами loopback (`"hostname": "0.0.0.0"`) **требует** bearer-токен: прокси
откажется запускаться без `EASYPROXY_API_AUTH_TOKEN`, и каждый клиентский запрос должен нести его
как `x-easyproxy-api-key`. Подробности: [справочник по конфигурации](https://easyproxy.me/ru/reference/configuration/).

<details>
<summary><b>Пул аккаунтов ChatGPT (расширенный)</b></summary>

Самостоятельно размещаемые опции для опытных пользователей. Перед включением проверьте условия каждого провайдера.

easyproxy также умеет управлять **пулом аккаунтов ChatGPT** для аутентификации Codex. Добавьте
несколько аккаунтов ChatGPT / Codex и обновляйте их квоты за 5 ч / неделю / 30 дней в панели.
При маршрутизации по квоте новые сессии могут использовать работоспособный аккаунт с наименьшим
использованием; round-robin и fill-first применяют свои политики. Существующие треды Codex
обычно сохраняют привязку к аккаунту, с которого начались, поэтому длинные сессии по SSH,
в tmux или с мобильного устройства не перескакивают между аккаунтами посреди разговора, однако
повторная оценка квот, failover, исключение аккаунта, истечение привязки или восстановление
после 401/403 и 429 могут перепривязать их. Задайте аккаунтам порядок выбора, если один из
них (например вход Codex Desktop) должен использоваться только после того, как остальные
исчерпаны.

- **Пул аккаунтов ChatGPT:** привязка тредов, автопереключение с учётом квот, кулдаун и
  fail-closed обработка аутентификации.

  > **Замечание о политике провайдеров:** пул аккаунтов нужен только для маршрутизации и
  > операционной устойчивости; он не гарантирует защиты от лимитов провайдера, принудительных
  > мер, блокировок и других действий в отношении аккаунтов. EasyProxy не одобряет использование
  > дополнительных аккаунтов для обхода лимитов провайдера и совместное использование учётных
  > данных между людьми. Вы отвечаете за соблюдение актуальных условий каждого провайдера. См.
  > [руководство по пулу аккаунтов Codex Auth](https://easyproxy.me/ru/guides/web-dashboard/)
  > и [актуальные Terms of Use OpenAI](https://openai.com/policies/terms-of-use/).

</details>

## Разработка

Разработка из исходников требует CLI `bun` в вашем `PATH`. Опубликованный npm-пакет содержит свой рантайм Bun
для установленных команд `epx`; скрипты пакета также могут находить Bun через эту встроенную зависимость.

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run typecheck
bun run test
```

## Документация

Публичная документация собирается из [`docs-site/`](../docs-site) и публикуется на **[easyproxy.me](https://easyproxy.me/ru/)**:

- [Установка](https://easyproxy.me/ru/getting-started/installation/)
- [Провайдеры](https://easyproxy.me/ru/guides/providers/)
- [Маршрутизация моделей](https://easyproxy.me/ru/guides/model-routing/)
- [Комбо](https://easyproxy.me/ru/guides/combos/)
- [Интерфейс подагентов](https://easyproxy.me/ru/guides/sub-agent-surface/)
- [Веб-дашборд](https://easyproxy.me/ru/guides/web-dashboard/)
- [Настольное приложение](https://easyproxy.me/ru/guides/desktop-app/)
- [Развёртывание Remote Hub](https://easyproxy.me/ru/guides/remote-hub/)
- [Справочник CLI](https://easyproxy.me/ru/reference/cli/)
- [Справочник по конфигурации](https://easyproxy.me/ru/reference/configuration/)

Заметки мейнтейнеров, служащие источником истины, находятся в [`structure/`](../structure),
сообщения о проблемах безопасности находятся в [`SECURITY.md`](../SECURITY.md).
Нераскрытые уязвимости сообщайте приватно через
[GitHub private vulnerability reporting](https://github.com/AquilaXk/easyproxy/security/advisories/new),
а не публичный issue.
Эта форма является единственным техническим каналом, отдельного адреса для безопасности нет. Дальнейшее
обсуждение остаётся внутри приватного отчёта; в публичном issue допустима только координация, но
не детали уязвимости. Подтверждение получения отчёта не равно его разбору, и срок первого ответа
не обещан.

## Обратная связь

Нашли ошибку или не хватает функции? [Откройте задачу](https://github.com/AquilaXk/easyproxy/issues) или загляните в [документацию](https://easyproxy.me/ru/). Если EasyProxy экономит вам время, звезда поможет другим найти проект.

## Спонсорство

EasyProxy бесплатен и распространяется с открытым исходным кодом. Спонсорская поддержка оплачивает время разработки и токены моделей для тестирования: [github.com/sponsors/AquilaXk](https://github.com/sponsors/AquilaXk).

### Поддерживающие

Здесь может быть ваше имя: [стать спонсором](https://github.com/sponsors/AquilaXk).

## Политика подписи кода (Code signing policy)

Исполняемые файлы Windows переходят на подпись Authenticode. В [руководстве по подписи кода Windows](https://easyproxy.me/ru/reference/code-signing/) описаны ход внедрения, проверка подписи и полная политика.

Free code signing provided by [SignPath.io](https://about.signpath.io/), certificate by [SignPath Foundation](https://signpath.org/).

- Committers and reviewers: [AquilaXk](https://github.com/AquilaXk)
- Approvers: [AquilaXk](https://github.com/AquilaXk)
- Privacy: easyproxy sends one anonymous daily usage summary (a per-day install hash that changes daily, version, release channel, platform, install channel, provider kind, coarse model family, active minutes and request, token and error counts; never prompts, model outputs, keys, accounts, hostnames or paths) to telemetry.easyproxy.me, and only after the person installing or operating it has seen the notice in the dashboard or an interactive CLI prompt and has not declined. It can be turned off in that notice, in the Windows installer ("Send anonymous usage statistics", checked by default), in Proxy details, or with epx telemetry disable, EPX_TELEMETRY=0 or DO_NOT_TRACK=1. Only project-wide aggregates of this anonymous data are public. A separate public leaderboard profile is off unless you connect one yourself (dashboard Home or epx telemetry profile connect); it shares only a chosen handle, display name and colour and your daily request, token and model-family totals, never your anonymous telemetry ID, and disconnecting deletes it. Everything else goes only to the providers and services you configure. See the [telemetry guide](https://easyproxy.me/ru/guides/telemetry/).

## Отказ от ответственности

easyproxy — независимый проект, поддерживаемый сообществом; он **не аффилирован с OpenAI, Anthropic или любым другим провайдером и не одобрен ими**.

Некоторые провайдеры (в частности Anthropic Claude) могут приостанавливать или ограничивать аккаунты, которые направляют API-трафик через сторонние прокси. **Используйте на свой страх и риск (UAYOR).** Прежде чем подключать провайдера, изучите его Terms of Service и убедитесь, что доступ через прокси разрешён. Мейнтейнеры easyproxy не несут ответственности за какие-либо действия вышестоящих провайдеров в отношении аккаунтов.

## Лицензия

EasyProxy распространяется по [лицензии MIT](../LICENSE). Сторонние компоненты сохраняют собственные лицензии; см. [`THIRD_PARTY_NOTICES.md`](../THIRD_PARTY_NOTICES.md).
