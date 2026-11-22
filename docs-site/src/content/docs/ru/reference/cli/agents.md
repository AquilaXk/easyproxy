---
title: CLI для агентов, маршрутизации и интеграций
description: Multi-agent, combo, observability, access, integration, system и config-команды.
---

Эти команды управляют политикой агентов и routing'ом, проверяют живой прокси и подключают
поддерживаемых клиентов к easyproxy.

## Политика агентов

### `epx agent <status|injection|effort|subagents|fallback|sidecar> ...`

Управляйте headless-ростером multi-agent, effort cap'ами, prompt injection, fallback'ом и
настройками sidecar'ов. Для просмотра текущей политики используйте `status`. Как соотносятся
surface mode, delegation, effort и fallback, описано в
[Поверхности подагентов](/guides/sub-agent-surface/).

```bash
epx agent subagents set ark/model-a,openai/gpt-5.5
epx agent sidecar web --enabled off
```

`--enabled off` — тот же переключатель, что и строка **Выкл. (Off)** в дашборде: EasyProxy
перестаёт запускать сайдкар, а интеграция Codex записывает `web_search = "disabled"` в
`~/.codex/config.toml`, что и позволяет использовать MCP-сервер как единственный путь поиска.
`--enabled on` снова удаляет эту строку. Когда сохранение действительно переключает
состояние, команда сообщает о записи на стороне Codex (`codexWebSearch` в `--json`,
иначе завершающая строка `Codex config:`) и предлагает `epx sync`, если запись не
удалась. Флаг работает и для `vision`.

### `epx v2 <status|on|off|mode <v1|default|v2|v2-plaintext>|threads <n>>`

Управляйте feature flag'ом Codex `multi_agent_v2` и четырёхсостоянием multi-agent surface mode.

| Подкоманда | Действие |
| --- | --- |
| `status` (default) | Показать текущий v2 flag, multi-agent mode и thread concurrency. |
| `on` | Включить feature `multi_agent_v2` и пересинхронизировать каталог. |
| `off` | Выключить `multi_agent_v2` и пересинхронизировать каталог. |
| `mode v1` | Принудительно перевести все модели на v1, отключить native v2 и сохранить текущий thread limit. |
| `mode default` | Уважать upstream pin'ы surface у моделей. |
| `mode v2` | Выбрать v2 для моделей и сохранить thread limit. При выключенном `keep-native-v1` включается глобальный native v2; при включённом глобальное принуждение отключается и используются pin'ы каталога. |
| `keep-native-v1 on\|off` | В режиме v2 оставить нативные модели ChatGPT на v1, а маршрутизируемые — на v2; включение отключает глобальное принуждение V2 перед синхронизацией каталога. |
| `mode-hint <text>` | Задать подсказку проактивного делегирования для всех моделей и уровней effort. |
| `mode-hint --clear` | Удалить подсказку и вернуть политику, зависящую от effort. |
| `mode v2-plaintext --acknowledge-plaintext-agent-messages` | Выбирает V2 для новых сессий и передаёт подходящие задачи открытым текстом без глобального принуждения. Для включения нужен `--acknowledge-plaintext-agent-messages`. |
| `threads <n>` | Задать активный v1/v2 thread limit как целое число не меньше 1. |

```bash
epx v2 status
epx v2 mode v1
epx v2 mode default
epx v2 on
epx v2 threads 16
```

Подкоманда `mode` записывает `multiAgentMode` в конфиг easyproxy и заново синхронизирует каталог
Codex. При переходах mode и feature flag текущий числовой thread limit переносится между
допустимыми ключами Codex для v1/v2; если переход не удался, исходный `config.toml`
восстанавливается. Изменения применяются к новым сессиям Codex, а уже запущенные сохраняют свою
закреплённую surface. При включённой компиляции последующие подходящие запросы существующих V2-сессий также обрабатываются; шифротекст не расшифровывается, а отключение не удаляет сохранённые копии. Переключатель Ultra в дашборде доступен при явно выбранном `v2` с включённой нативной функцией или при `v2-plaintext`, где V2 закреплён в каталоге; одного `epx v2 on` недостаточно.

## Combo routing

### `epx combo <list|show|set|remove> ...` · `epx route combo ...`

Управляйте virtual-моделями combo с failover и round-robin. `epx route combo` — это иерархический
alias; на данный момент combo — единственный поддерживаемый routing-resource. Цели используют
форму `provider/model[:weight],provider/model[:weight]`.

```bash
epx combo list
epx route combo set reliable --targets ark/model-a:2,openai/gpt-5.5
```

О поведении маршрутизации и рекомендациях по конфигурации см. [Combos](/guides/combos/).

## Observability и debug

### `epx observe <logs|usage|storage|memory|debug|claude-inbound|injection> ...`

Проверяйте proxy-request'ы, usage, storage, memory и debug-data. Прямые alias'ы:

| Алиас | Эквивалентный ресурс |
| --- | --- |
| `epx logs [filters] [--follow] [--json|--jsonl]` | `epx observe logs` |
| `epx usage [--range <today|1d|7d|30d|all>] [--surface <all|codex|claude|grok>] [--provider <name>] [--model <id>] [--json]` | `epx observe usage` |
| `epx storage [--json]` | `epx observe storage` |
| `epx memory [--json]` | `epx observe memory` |

```bash
epx observe usage --range 30d --json
```

Если часть записей нельзя учесть, человекочитаемый вывод показывает предупреждение, даже если нет читаемых строк. Отображаемые итоги учитывают только читаемые записи. Если фильтр не находит читаемых совпадений, вместо строк итогов выводятся предупреждение и подсказки; пропущенные записи могут содержать совпадения. `--json` сохраняет диагностику `usageIncomplete` и её причину из ответа.

### `epx debug <provider|usage|injection|claude> <on|off|status|reset|logs [-f]>`

Прочитать или изменить runtime debug-override'ы через management API работающего прокси.

```bash
epx debug provider on|off|status|reset
epx debug provider logs [-f|--follow]
epx debug usage on|off|status|reset
epx debug usage logs [-f|--follow]
```

Без указания scope `epx debug` печатает usage и, если прокси остановлен, environment-default'ы
для следующего запуска. Provider debug по умолчанию берётся из `EPX_DEBUG=1`
(legacy `EPX_DEBUG_FRAMES=1` тоже работает); usage debug — из `EASYPROXY_USAGE_DEBUG=1`.

## Доступ к API

### `epx access <key|endpoints|models|test> ...`

Просматривайте список API-ключей доступа к EasyProxy, внешние конечные точки и модели. `epx api-key` — псевдоним семейства команд `epx access key`.

Создание ключа и начало ротации возвращают секрет в открытом виде, показываемый только один раз, как в текстовом формате, так и в JSON. Агент должен передать эти действия человеку, который выполнит их вручную в терминале вне сеанса агента. Не запрашивайте сам ключ в чате: нужны только подтверждение настройки и проверки подключения, а также несекретные идентификаторы ключа и ротации.

```bash
epx access key list --json
```

Подтверждение работы нового ключа не является разрешением отозвать старый. Для завершения ротации или удаления старого ключа требуется отдельное явное разрешение на отзыв именно этого ключа. После разрешённой операции снова проверьте список. Не обходите этот порядок прямым вызовом API.

## Интеграции клиентов

### `epx integration <claude|grok> ...`

Управляйте поддерживаемыми интеграциями Claude и Grok. Прямые семейства команд ниже
предоставляют элементы управления, специфичные для каждого клиента.

### `epx claude [claude args...]`

Убедиться, что прокси запущен, а затем запустить Claude Code с `ANTHROPIC_BASE_URL`,
`ANTHROPIC_AUTH_TOKEN`, `CLAUDE_CODE_ENABLE_GATEWAY_MODEL_DISCOVERY=1` и model slot'ами из
`config.claudeCode`. Маршрутизируемые модели появляются в native-picker'е `/model` через стабильные
slot-alias'ы, начиная с Claude Code 2.1.129. На более старых версиях модель выбирается через
`ANTHROPIC_MODEL` или `/model <id>`. Пользовательские `ANTHROPIC_*`, экспортированные в окружение,
всегда имеют приоритет.

Команды для профиля Claude Desktop:

```text
epx claude desktop [apply]                         Save and apply the four-family profile
epx claude desktop show [--json]                   Show routes, families, and defaults
epx claude desktop move <route> <family> [--default]
epx claude desktop default <family> <route|none>
epx claude desktop export <path|->                 Export versioned JSON (`-` = stdout)
epx claude desktop import <path> [--apply]         Validate and import JSON
```

Семейства — `opus`, `fable`, `sonnet` и `haiku`; новые маршруты по умолчанию попадают в `opus`.
`none` допустимо только когда соответствующее семейство пусто. Legacy-flags `--static`,
`--hybrid` и `--discovery-only` для apply по-прежнему поддерживаются. Для настроек Claude Code
используйте `epx claude config <status|set> ...`.

### `epx codex [codex args...]`

Ключ передаётся только когда конфигурация и её пространства имён защищены от изменения другими субъектами; текущий пользователь и привилегированные субъекты ОС считаются доверенными. Процессы того же пользователя доверенные: субъект с вашими правами записи уже может прочитать ваш файл ключа EasyProxy. Замена конфигурации тем же пользователем между проверкой и нативным запуском находится вне этой модели угроз; конфигурация при передаче управления не фиксируется.

При обычной установке Windows права ProgramData по умолчанию позволяют другим пользователям создавать каталоги. Поэтому автоматические учётные данные не передаются даже при отсутствии `ProgramData\OpenAI\Codex`. Папка системной конфигурации Codex в ProgramData должна существовать и быть доступна для записи только Administrators/SYSTEM; родительские каталоги должны быть защищены от замены другими пользователями. Попросите администратора проверить политику каталогов. easyproxy никогда не меняет ACL самостоятельно и не предоставляет команду подготовки.

Вместо этого можно передать ключ самостоятельно, например экспортировав `EASYPROXY_API_AUTH_TOKEN`; `epx codex` оставляет его значение без изменений. Существующие системные файлы конфигурации по-прежнему блокируют автоматические учётные данные и требуют отдельной проверки. Для каждой причины отказа выводится одна короткая конкретная строка stderr без значений ключей, содержимого или путей файлов ключей.

Перед подсказкой из одного слова укажите `--`, чтобы исключить выбор неизвестной подкоманды Codex.

Пространство машинной конфигурации должно запрещать другим пользователям создание отсутствующих системных файлов. Непроверенный Windows ProgramData/OpenAI/Codex запрещает передачу токена; каталог не создаётся. macOS допускает ACL только с запретами и разрешения только на чтение. Любое разрешение записи, добавления, удаления, изменения атрибутов, безопасности или владельца блокирует передачу даже после запрещающей записи. Неизвестные теги и ошибки проверки также блокируют её.

Новый служебный токен читается только если argv входит в список ниже, нет непустых переменных прокси HTTP(S)/ALL или переопределений `CODEX_*`/`OPENAI_*`/`AZURE_OPENAI_*` (канонический `CODEX_HOME` разрешён), а пространства home/config/system проходят проверку владельца. Нужны только проверенные ключи и точный управляемый loopback-провайдер, без дополнительных потребителей учётных данных и слоёв конфигурации. Любой аргумент вне списка, включая `-c`/`--config`, `-p`/`--profile`, неизвестные флаги и `resume`/`fork`, блокирует токен с диагностикой без значений; явные учётные данные и исходные аргументы сохраняются.

Канонический каталог и `config.toml` должны принадлежать текущему пользователю. POSIX запрещает запись group/other; Windows проверяет SID владельца и запрещает запись DACL всем, кроме текущего пользователя, SYSTEM и Administrators. Проверяются права замены родительских путей. На macOS также не должно быть принудительных настроек Codex. Эти проверки не изолируют вредоносный процесс того же пользователя или администратора.

| Allowlist | Flags |
| --- | --- |
| Switches | `--no-daemon`, `--json`, `--ephemeral`, `--skip-git-repo-check`, `--no-alt-screen`, `--full-auto`, `--dangerously-bypass-approvals-and-sandbox`, `--search` |
| One value | `--model`/`-m`, `--sandbox`/`-s`, `--ask-for-approval`/`-a`, `--image`/`-i` |



При автоматическом чтении учётных данных `CODEX_HOME` трактуется как буквальный путь, включая `~` и пробелы. После проверки дочерний процесс получает тот же канонический абсолютный путь. Недоступный каталог отключает чтение. Любое непустое значение `HTTP_PROXY`, `HTTPS_PROXY` или `ALL_PROXY` без учёта регистра также отключает чтение независимо от `NO_PROXY`; отклонённые запуски и экспортированные пользователем учётные данные не меняются. При передаче нового токена в обе переменные дочернего процесса `NO_PROXY` и `no_proxy` добавляются `127.0.0.1` и `::1` с сохранением прежних исключений. Включение `features.respect_system_proxy` или передача `--enable`/`--disable` отключает автоматическое чтение.

Лаунчер пытается запустить прокси и передаёт Codex исходные аргументы, не переписывая конфигурацию. Нативные маршруты и чужие шлюзы пропускают запуск прокси. Неизвестный маршрут предупреждает и пытается запустить прокси; неудача предупреждает и продолжает выполнение. Справка, версия и внутренние команды `login`, `doctor`, `help` пропускают запуск и автоматическое чтение токена.

Отсутствующий `EASYPROXY_API_AUTH_TOKEN` читается из `service-api-token` этой установки только при полном совпадении транспортной конфигурации выбранного provider с управляемым блоком для настроенного loopback-слушателя или сохранённого локального клиентского подключения. Имя и комментарии не дают разрешения. Неизвестные или удалённые адреса, profile по умолчанию, конфигурация проекта, `OPENAI_BASE_URL` и переданные `-c`/`--config`, `-p`/`--profile`, `-C`/`--cd`, `--remote` отключают автоматическое чтение. Экспортированные пользователем учётные данные и аргументы сохраняются; подмена файла токена и совпадения с административными токенами отклоняются.

Только совпавшая (`matched`) обёртка autostart запускает свой базовый Codex напрямую. Неизвестное состояние, включая исключение проверки, требует проверенного обхода; управляемая CMD-обёртка Windows должна полностью совпадать с текущим шаблоном для запуска с `EPX_SHIM_BYPASS=1`. Обычные npm-лаунчеры поддерживаются. Непроверяемая или устаревшая обёртка отклоняется с кодом 1 без запуска Codex; обновите её через `epx codex-shim install`. Запуск не исправляет shim; проверка содержимого не доказывает происхождение базового файла Windows и не предотвращает одновременную замену пути.

Справка лаунчера: `epx help codex`; справка Codex: `epx codex --help`. Последующий обычный запуск `codex` сохраняет прежнее поведение.

### `epx opencode [opencode args...]`

Убедиться, что прокси запущен, и затем запустить opencode со сгенерированными блоками
`provider.easyproxy` и `providers.easyproxy` в inline runtime layer OpenCode (`OPENCODE_CONFIG_CONTENT`). Существующая
inline-конфигурация сохраняется, а для этого запуска заменяются только эти два ключа.
Глобальные или проектные `opencode.json` могут читаться, чтобы выдать warning о существующем
override, но файлы на диске никогда не меняются. Маршрутизируемые модели появляются как
`easyproxy/<provider>/<model>`. Последующий запуск обычного `opencode` работает ровно как раньше.

### `epx grok <status|exclude|include|set|clear|apply> ...`

Управляйте fence'ом моделей для Grok Build и применяйте его.

## Экспорт client config

### `epx export --client <opencode|pi|omp|hermes|openclaw|kimi|gajae|dsh|mcode|zcode|prime|aside|raycast|omo|cline|kilo|commandcode|droid>`

Печатает client config, направленный на работающий прокси. Команда сериализует блок
провайдера `easyproxy` в нативном формате выбранного клиента: base URL, список моделей и,
в зависимости от клиента, credential reference либо заглушку `easyproxy-loopback`.

Прокси должен быть запущен; команда определяет его живой порт, читает `/api/models` и выводит
только те модели, которые сейчас видит Codex.

| Флаг | Действие |
| --- | --- |
| `--client <opencode\|pi\|omp\|hermes\|openclaw\|kimi\|gajae\|dsh\|mcode\|zcode\|prime\|aside\|raycast\|omo\|cline\|kilo\|commandcode\|droid>` | Обязателен. Выбирает формат конфигурации клиента. |
| `--json` | Печатать только JSON-конфиг в stdout, чтобы redirect сохранял побайтно точный вывод. Вся диагностика, включая заметку о записи через `--out`, идёт в stderr. |
| `--out <path>` | Записать конфиг в `<path>`. Перезаписывать существующий файл не позволит. |
| `--force` | Разрешить `--out` заменить существующий файл. |

```bash
epx export --client opencode                     # config plus destination, merge warning, and counts
epx export --client pi --json > pi-models.json   # JSON document for a pipe or a diff
epx export --client omp --out ./omp-models.yml    # native OMP YAML
epx export --client opencode --out ~/easyproxy-opencode.json
```

Без `--json` сначала идёт сгенерированная конфигурация в нативном формате выбранного клиента,
затем канонический путь назначения, предупреждение о merge, клиентская подсказка перед запуском
и количество моделей с указанием, сколько строк не имеют context limit'а (для них клиент применяет
собственные default'ы).

| Клиент | Канонический путь | Имя скачиваемого файла | Переменная окружения |
| --- | --- | --- | --- |
| `opencode` | `~/.config/opencode/opencode.json` (`XDG_CONFIG_HOME` имеет приоритет, если задан) | `opencode.json` | `EASYPROXY_OPENCODE_API_KEY` |
| `pi` | `~/.pi/agent/models.json` (`PI_CODING_AGENT_DIR` имеет приоритет, если задана; относительное значение отклоняется) | `pi-models.json` | нет — блок несёт литерал `easyproxy-loopback` |
| `omp` | `~/.omp/agent/models.yml` (по умолчанию; `OMP_PROFILE` имеет приоритет над `PI_PROFILE`, даже если пуст) | `omp-models.yaml` | нет — литерал `easyproxy-loopback` |
| `hermes` | `~/.hermes/config.yaml` | `hermes-config.yaml` | `EASYPROXY_HERMES_API_KEY` |
| `openclaw` | `~/.openclaw/openclaw.json` | `openclaw.json5` | `EASYPROXY_OPENCLAW_API_KEY` |
| `kimi` | `~/.kimi-code/config.toml` | `kimi-config.toml` | нет — loopback placeholder |
| `gajae` | `~/.gjc/agent/models.yml` | `gajae-models.yaml` | несекретное значение-заполнитель для loopback |
| `dsh` | `$DSH_HOME/settings.yaml` (по умолчанию `~/.dsh/settings.yaml`) | `settings.yaml` | нет — несекретная loopback bearer-заглушка |
| `mcode` | `~/.minimax/config.yaml` (`MINIMAX_DATA_DIR`, затем устаревшая `MAVIS_DATA_DIR`, имеют приоритет, если заданы; относительное значение отклоняется) | `mcode-config.yaml` | нет — loopback placeholder |
| `zcode` | `~/.zcode/v2/config.json` (`ZCODE_DATA_DIR` имеет приоритет, если задана; относительное значение отклоняется) | `config.json` | нет — loopback placeholder |
| `prime` | `~/.prime/agent/models.json` (`PRIME_AGENT_CODING_AGENT_DIR` имеет приоритет, если задана; относительное значение отклоняется) | `prime-models.json` | нет — loopback placeholder |
| `aside` | `~/.aside/u/<account>/models.json` для аккаунта, который `accounts.json` самого Aside называет текущим; нечитаемый манифест отклоняется, а не подменяется произвольным аккаунтом | `aside-models.json` | нет — loopback placeholder |
| `raycast` | `~/.config/raycast/ai/providers.yaml` одинаково на macOS и Windows (Raycast не учитывает `XDG_CONFIG_HOME`) | `raycast-providers.yaml` | нет — только loopback, запись `api_keys` не создаётся |
| `omo` | `~/.omo/agent/models.json` (`OMO_CODING_AGENT_DIR`, затем `SENPI_CODING_AGENT_DIR`, затем `PI_CODING_AGENT_DIR` имеют приоритет в этом порядке, если заданы; относительное значение отклоняется) | `omo-models.json` | нет — loopback placeholder |
| `kilo` | первый существующий файл среди `kilo.jsonc`, `kilo.json`, `opencode.jsonc`, `opencode.json` или `config.json` в `~/.config/kilo` (`XDG_CONFIG_HOME` переносит каталог); если ни одного нет, используется `kilo.jsonc` | `kilo.jsonc` | `EASYPROXY_KILO_API_KEY` |
| `commandcode` | `~/.commandcode/providers.json` (в Windows при использовании домашнего каталога по умолчанию: использовать `HOME ?? USERPROFILE`, только если значение не пустое, не состоит из пробелов и является абсолютным путём Windows, иначе `homedir()`; отдельно переданный домашний каталог сохраняется; добавить `.commandcode\providers.json`) | `providers.json` | только loopback; `apiKey: false`; переменная окружения не нужна |
| `droid` | `~/.factory/settings.json` (`%USERPROFILE%\.factory\settings.json` on Windows) | `factory-settings.json` | только loopback; переменная окружения не нужна |

Эти пути указаны по умолчанию. Абсолютный `dataBaseDir` в `~/.zcode/v2/setting.json`, который всегда остаётся в домашнем каталоге по умолчанию, переносит хранилище в `<dataBaseDir>/.zcode/v2/provider_config.json`. `ZCODE_DATA_DIR` задаёт сам корень `.zcode` и имеет приоритет над настройкой; `ZCODE_PERSONAL_PROVIDER_CONFIG_FILE` имеет приоритет для файла провайдеров. Нечитаемая, некорректная или относительная настройка блокирует новое применение и обновление. Существующие записи владения и восстановления сохраняются. См. [правила путей и восстановления на английском](https://easyproxy.me/guides/integrations/#zcode-314-and-later).

Экспорт для Raycast — это отдельный документ `providers.yaml` с одним элементом `id: easyproxy` в
последовательности `providers`: `name: EasyProxy`, базовый URL прокси с `/v1` и каждая маршрутизируемая
модель с её `abilities` (`tools` и `system_message` поддерживаются всегда, `vision` берётся из входных
модальностей каталога, `reasoning_effort` задаётся, когда у модели есть шкала усилий, `temperature`
отключена для рассуждающих моделей). Custom Providers — функция Raycast Pro, а Raycast следит за файлом,
поэтому сохранённое изменение вступает в силу без перезапуска. Формат описан на
[manual.raycast.com/ai/custom-providers](https://manual.raycast.com/ai/custom-providers). Запись
`api_keys` не создаётся, поэтому этот экспорт работает только через loopback, а привязка вне loopback
отклоняется.

opencode интерполирует `{env:EASYPROXY_OPENCODE_API_KEY}`. Сгенерированный easyproxy экспорт для
Pi не требует переменной окружения и несёт литеральную заглушку `easyproxy-loopback`. Это значение
обязательно: Pi разрешает `apiKey`, когда строит список моделей, и прячет провайдера целиком, если
существующий конфиг содержит ссылку на незаданную переменную окружения. На loopback прокси не
проверяет сгенерированную заглушку.

:::caution[Сливать, а не заменять]
`epx export` никогда не пишет в ваш реальный клиентский конфиг. Путь назначения лишь
печатается, чтобы вы вручную выполнили merge, а `--out` без `--force` отказывается перезаписать
существующий файл именно потому, что полная замена уничтожила бы остальные провайдеры, агенты и
MCP-записи.
:::

Никакой ключ никогда не сериализуется. Сгенерированные конфиги несут либо документированную
env-reference, либо несекретную loopback-заглушку. Адрес loopback (`127.0.0.1`) сам по себе не означает доступ без ключа: проверьте политику и endpoint. CLI-команды модели/аудио с выбранным ключом требуют явного ввода и на loopback. Если прокси слушает не на loopback, задайте соответствующую переменную
`EASYPROXY_OPENCODE_API_KEY`, `EASYPROXY_HERMES_API_KEY` или `EASYPROXY_OPENCLAW_API_KEY`.
Интеграция gjc использует несекретное локальное значение и не требует переменной окружения. Она поддерживает только loopback и не настраивает учётные данные удалённого доступа.
Как выдаются admission key, описано в
[Удалённом доступе](/ru/reference/configuration/server/#удалённый-доступ). Ключи upstream-провайдеров — это совсем
отдельная история и настраиваются в [Провайдерах](/guides/providers/).

Тот же payload отдаётся через `GET /api/client-config` и показывается на вкладке API в дашборде,
поэтому CLI, API и GUI используют в точности одни и те же байты.

## Runtime и configuration

### `epx system <status|settings|startup|diagnostics|sync|codex-app-server|codex-restart|update|codex-cli-update> ...`

Управляйте headless runtime-setting'ами, startup, sync, diagnostics и update.

`epx system codex-restart --yes` перезапускает Codex app-server'ы тем же модулем, что и `epx sync --restart-codex`. Desktop-приложение Codex полностью закрывается и запускается заново, если оно было запущено до записи текущего каталога моделей или этот запрос изменил привязку `model_catalog_json`, потому что выбор модели строится при запуске. Иначе приложение остаётся открытым, само перезапускает свой app-server и сохраняет неотправленные черновики и ожидающие подтверждения. Если состояние приложения или каталога прочитать нельзя, выполняется полный перезапуск. Если сам proxy запущен внутри приложения Codex, перезапуск Desktop отказывается с actionable-сообщением вместо handoff, который он не может завершить.

Изменение привязки `model_catalog_json` этим запросом также вызывает перезапуск Desktop, даже если процесс оболочки запущен после записи файла каталога.

```bash
epx system settings --stream-mode eager-relay
```

`epx system update` обновляет сам EasyProxy. Для Codex CLI используйте отдельную read-only команду:

```bash
epx system codex-cli-update check --json
```

`check` не обращается к реестру и не запускает Codex. В POSIX `selectionAttested` может быть `true`, если разрешитель выбирает тот же канонический путь, что и кандидат окружения, зафиксированный опубликованным средством запуска. Связанный манифест npm-global может подтвердить `managed: true`, если он доказывает владение и, когда версия кандидата сообщается, она совпадает с версией манифеста; сохранённые кандидаты остаются неаттестованными. Windows x64 также поддерживает привязанный к доказательству абсолютный стандартный npm `codex.cmd` с цепочкой инструментов Node/npm — локальной для префикса при её наличии, иначе парой из захваченного PATH, привязанной к архитектуре средства запуска, — и проверенной внутрипрефиксной платформенной подложкой, используя удерживаемые дескрипторы, отклоняющие reparse. Остальные раскладки Windows остаются отложенными или неуправляемыми. Результат `managed` в Windows классифицирует только наблюдаемую раскладку установки: привязанные Node/npm — это цепочка инструментов метаданных средства обновления, доступная только для чтения, а не гарантия того, какой интерпретатор разрешит последующий вызов `codex.cmd`. Прямой запуск через Bun или исходный код не даёт доказательства средства запуска. `plan` обращается к официальному реестру с изолированными временными настройками, кешем и журналами npm, отказывая при активных сессиях или неполном наблюдении процессов. Он ничего не устанавливает и не посылает сигналы. Windows x64 apply требует ограниченного префикса npm с проверенным частным правом записи и сохраняет несвязанные пакеты и shim; неподдерживаемые наблюдаемые раскладки возвращают `applicable: false` и `refusal: windows_apply_disabled`; выбор только по PATH, обёртки автозапуска EasyProxy и откат к global/vendor остаются отложенными. См. [полное описание команд и причин отказа (англ.)](/reference/cli/agents/#read-only-codex-cli-update-plan).

В Windows захваченная команда без полного пути, например `CODEX_CLI_PATH=codex`, удалённый путь или путь устройства возвращает `candidate_path_unavailable`. Кандидат захвачен, но его путь не подходит для этой проверки.

#### Явное наблюдение установки Windows x64

```text
epx system codex-cli-update attest [--json]
epx system codex-cli-update attest --candidate <absolute-path> --npm-prefix <absolute-path> --npm-cli <absolute-path> --node <absolute-path> [--json]
```

`attest` — необязательная операция только для чтения выбранной или явно указанной установки npm на Windows x64. Без параметров команда наблюдает выбранный кандидат, определённый доверенным снимком средства запуска (настроенный `CODEX_CLI_PATH` или первый `codex` в захваченном PATH), а обёртка easyproxy разрешается в переименованную npm-резервную копию `codex.easyproxy-real.cmd`. Передача всех четырёх абсолютных путей переопределяет поиск; поиск лишь предлагает пути, а наблюдение с удерживаемыми дескрипторами остаётся окончательным. `--candidate` указывает стандартный npm `<prefix>/codex.cmd` или `<prefix>/node_modules/@openai/codex/bin/codex.js`. Путь `--npm-cli` должен заканчиваться на `node_modules/npm/bin/npm-cli.js`, а `--node` явно указывает `node.exe`. Встроенные в приложения установки, распознанные каталоги менеджеров версий, shim easyproxy без npm-резервной копии и пользовательские обёртки отклоняются.

При ограниченном чтении нативные дескрипторы удерживают родительские каталоги и файлы. Неподдерживаемые платформы, точки повторной обработки/junction, конфликтующая запись, небезопасные пути и слишком большие файлы отклоняются. Отчёт фиксированной формы не содержит путей: `status` равен `observed` или `refused`, также возвращается `installationIdentityObserved`. Поля `selectionAttested`, `managed` и `applyAllowed` остаются `false`. Проверяйте `status`: отказ в отчёте может сопровождаться кодом выхода 0.

Идентификатор или хеш описывает файлы в момент наблюдения, а не выдаёт постоянное разрешение на обновление. Он не доказывает выбранный runtime, прошлый установщик, действующую конфигурацию npm или подлинность инструментов. Указанный Node лишь наблюдается; выбор его запускателем не подтверждается. Команда не запускает цели, не обращается к реестру пакетов, не устанавливает ПО, не пишет конфигурацию и не управляет процессами. Существующий Windows `check` по-прежнему не выполняет файловый ввод-вывод кандидатов или конфигурации.

### `epx config [show|get|set|unset|validate|export|import] ...`

`epx config [show] [--json] [--source]` показывает локальную конфигурацию без запущенного прокси. `show` можно опустить при использовании любого из флагов или обоих в любом порядке. `--source` добавляет источник, ошибки и предупреждения диагностики и разрешён только при просмотре. `--json` может предшествовать явно указанному действию, не меняя его. Повторные флаги `--json` или `--source` и неизвестные аргументы отклоняются.

Проверяйте и безопасно меняйте валидированную конфигурацию EasyProxy. `show` и `get`
маскируют секреты. Импорт выполняет валидацию перед записью и требует `--yes`.

### Forced Claude Code subagent model

The Subagents page offers **Force all subagents onto one model**, off by default. Select an exposed roster-style id, such as `combo/tev-auto`, then enable the switch. The roster is offered first; unavailable saved roster entries cannot be force targets.

`epx agent subagents force combo/tev-auto` sets `claudeCode.subagentModelForce`; `epx agent subagents force -` clears it. `epx agent status` reports the setting. `GET /api/subagent-models` returns `force`, `forceAvailable`, and `forceStatus`; `PUT` accepts `{ "force": "combo/tev-auto" }` or `{ "force": null }` without changing the roster. Omitting `force` leaves it unchanged. Invalid or unexposed targets are rejected on write; stale targets are reported and skipped at launch.

This takes effect on the **next routed `epx claude` launch**, injecting `CLAUDE_CODE_SUBAGENT_MODEL` as an explicit proxy alias (with `[1m]` only for an authoritative million-token window; native Claude targets use a reversible native alias) and `CLAUDE_CODE_SUBAGENT_MODEL_FORCE=1`. Each nonempty shell-exported variable independently wins. Native launches inject neither variable; plain `claude` is not affected. No plugin files or `settings.json` are modified by this setting.

Claude Code **2.1.257 or newer** is required for FORCE. Plugin and built-in agents (including Explore/Plan) and per-call model arguments are overridden. Forks and subagent skills with `model: inherit` keep the main conversation model. The main loop and Haiku/small-fast sidecars are unaffected. Existing roster files remain available.

The dashboard warns about old or unknown CLI versions, unavailable targets, and either variable already present in `settings.json` → `env` (which overrides launch env). Detection is read-only and server-local: it cannot inspect another launch shell, another machine, or project-local settings. An unknown result is not proof of force support.

## Hermes / Command Code: model names

Hermes and Command Code support `--model-names alias|routed` (API: `modelNames`).
The default is `routed`, independent of `preferModelAliasIds`. A connection
stores its mode; later Apply without the option preserves it. Alias mode uses
only provider-qualified aliases that the router proves equivalent; missing,
unsafe or colliding aliases fall back to routed keys. Combos keep their keys.
Removed/renamed aliases migrate on the next successful managed refresh, with
foreign-edit refusal. Named Hermes profiles need explicit Apply.

`epx export --client hermes --model-names alias --json` previews a current
already loaded catalog without writing client files or managed state; a cold or
stale catalog returns unavailable. Explicit `--out` writes an export artifact.
See the [English integration guide](/guides/integrations/#opt-in-alias-model-names)
for the canonical workflow.
