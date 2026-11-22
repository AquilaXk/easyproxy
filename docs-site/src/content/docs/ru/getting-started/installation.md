---
title: Установка
description: Установите прокси easyproxy (epx) и необходимые компоненты и убедитесь, что он запускается.
---

easyproxy устанавливает два эквивалентных имени команды: `epx` и `easyproxy`. Обе запускают один и
тот же небольшой локальный HTTP-сервер (построенный на Bun). Запросы к моделям идут к провайдеру,
выбранному маршрутизацией; опциональные сайдкары для vision и веб-поиска также могут использовать
ваш вход в ChatGPT, когда они нужны маршрутизируемой модели.

## Предварительные требования

| Требование | Зачем |
| --- | --- |
| **[Node](https://nodejs.org) ≥ 18** | `epx` работает на рантайме Bun, но рантайм автоматически поставляется в комплекте при `npm install` — устанавливать Bun самостоятельно **не нужно**. |
| **[OpenAI Codex](https://openai.com/codex)** (CLI, App или SDK) | Клиент, перед которым работает easyproxy. easyproxy записывает данные в `$CODEX_HOME/config.toml` (по умолчанию `~/.codex/config.toml`). |
| Аккаунт провайдера или API-ключ | Anthropic, xAI, Kimi, Ollama Cloud, OpenRouter, OpenAI-совместимая конечная точка или ваш вход в ChatGPT. |

## Установка

```bash
npm install -g --allow-scripts=bun easyproxy
```

:::note[npm заблокировал postinstall-скрипт bun?]
Свежие версии npm могут блокировать postinstall-скрипт bun (`npm warn
install-scripts ... blocked because they are not covered by allowScripts`),
из-за чего встроенный рантайм Bun остаётся неподготовленным. Переустановите
пакет, разрешив скрипт bun, — и обязательно указывайте имя пакета: в
сокращённой подсказке npm его нет, и без него вместо пакета переустановится
текущий каталог:

```bash
npm install -g --allow-scripts=bun easyproxy

# если изначально устанавливали через sudo, продолжайте использовать sudo:
sudo npm install -g --allow-scripts=bun easyproxy
```
:::

Убедитесь, что оба псевдонима команды доступны в `PATH`:

```bash
epx --version
easyproxy --version
```

## Автономный бинарный файл (без npm)

В релиз входят автономные бинарные файлы `epx` для поддерживаемых macOS, Linux и Windows.
Они содержат рантайм Bun и дашборд, поэтому npm, Node и отдельная установка Bun не нужны.
Скачайте архив для своей платформы, распакуйте его и выполните:

```bash
./epx --version
./epx start
```

Чтобы дашборд был доступен, оставьте распакованный каталог `gui/dist` рядом с бинарным файлом.

### Каналы релизов

Стабильный канал `latest` уже включает поддержку каталога GPT-5.6 Sol/Terra/Luna для маршрутов
ChatGPT, OpenAI по API-ключу, OpenRouter и экспериментального Cursor. Доступ у вышестоящего
провайдера по-прежнему зависит от аккаунта; сами по себе записи каталога доступ не дают.
Используйте канал preview только для тестирования ещё не выпущенных сборок easyproxy:

```bash
npm install -g --allow-scripts=bun easyproxy@preview
epx update --tag preview
```

## Запуск из исходного кода

Чтобы работать над самим easyproxy:

```bash
git clone https://github.com/AquilaXk/easyproxy.git
cd easyproxy
bun install
bun run dev:proxy   # запускает API прокси в режиме разработки (src/cli/index.ts start)
bun run dev:gui     # запускает dev-сервер панели управления (в другом терминале)
```

`bun run dev` остаётся псевдонимом для `bun run dev:proxy`. API прокси предоставляет `/healthz`,
`/v1/responses` и `/api/*`; `GET /` отдаёт упакованную панель управления только после того, как
`bun run build:gui` создаст `gui/dist`. Пока вы работаете над панелью управления, запускайте
фронтенд отдельно командой `bun run dev:gui`.

## Что создаётся

Состояние easyproxy хранится в `$EASYPROXY_HOME` (по умолчанию `~/.easyproxy`). Файлы интеграции
с Codex находятся в `$CODEX_HOME` (по умолчанию `~/.codex`).

| Путь | Назначение |
| --- | --- |
| `$EASYPROXY_HOME/config.json` | Ваши провайдеры, провайдер по умолчанию, порт и параметры. |
| `$EASYPROXY_HOME/epx.pid` | PID запущенного прокси (защита от повторного запуска). |
| `$EASYPROXY_HOME/runtime-port.json` | Текущие PID, имя хоста и порт, включая порт, назначенный ОС, когда `config.port` равен `0`. |
| `$EASYPROXY_HOME/auth.json` | Сохранённые учётные данные OAuth (после `epx login`). |
| `$EASYPROXY_HOME/catalog-backup*.json` | Резервные копии каталога моделей Codex, создаваемые перед тем, как easyproxy его изменит. |
| `$CODEX_HOME/config.toml` | На loopback-адресе easyproxy добавляет корневой `openai_base_url`, отмеченный собственным маркером; при привязке не к loopback используются `model_provider = "easyproxy"` и `[model_providers.easyproxy]`, чтобы Codex мог отправлять заголовок API-аутентификации. |
| `$CODEX_HOME/easyproxy.config.toml` | Резервный/справочный профиль, записываемый рядом с основной конфигурацией Codex. |
| `$CODEX_HOME/easyproxy-catalog.json` | Синхронизированный каталог нативных и маршрутизируемых моделей, используемый Codex. |

:::note
easyproxy никогда не удаляет вашу конфигурацию Codex. Каждое внедрение обратимо — `epx stop`,
`epx restore` или `epx eject` убирают ровно те строки, которые добавил easyproxy, и восстанавливают
нативный Codex.
:::

## Далее

Переходите к разделу [Быстрый старт](/ru/getting-started/quickstart/), чтобы настроить
первого провайдера, или прочитайте [Как это работает](/ru/getting-started/how-it-works/),
чтобы разобраться в архитектуре.
