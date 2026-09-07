# План: полноценный wizard, Easy/Advanced и свобода выбора runtime

## Статус и назначение

- Дата: 2026-09-06.
- Статус: подробный план реализации; production-код этим коммитом не изменён.
- База исследования: `origin/main`, `3208b6d30fdd37de7990e69e4b7ec5a09646a27a`.
- Worktree подготовки: `/Volumes/Orange/Projects/.worktrees/triss/wizard-full-setup-plan`.
- Ветка подготовки: `docs/wizard-full-setup-plan`.
- Авторитетное решение владельца: [User choice, best-effort execution, and easy setup](../adr/2026-09-05-user-choice-and-easy-setup.md).
- Инструкции исполнителю: [CONTRIBUTING.md](../../CONTRIBUTING.md), [ARCHITECTURE.md](../../ARCHITECTURE.md).

План предназначен для coding-модели, которой нужны конкретные границы задач,
контракты, файлы, последовательность и проверяемые результаты. Не заменять эти
решения собственными «более безопасными» ограничениями. Старые комментарии,
security-документы и тесты описывают текущую реализацию, но не отменяют ADR.

**Реализация не считается завершённой после обновления интерфейса wizard или
удаления первой блокирующей проверки. Выбранный маршрут должен реально работать
через CLI и MCP. Недостающие adapters входят в эту работу.**

## 1. Цель, антицель и обязательные решения

### 1.1. Цель

Сделать `triss config wizard` удобным и полноценным: он настраивает выбранные
пользователем функции до рабочего состояния, поддерживает все существующие
providers, coding engines, интеграции и действующие параметры Triss.

- Easy запускается по умолчанию и задаёт минимум необходимых вопросов.
- Advanced доступен по желанию и позволяет тонко настроить всё поддерживаемое.
- Targeted-вызов настраивает один раздел той же системой, а не отдельным wizard.
- Повторный запуск сохраняет существующий выбор, а не начинает установку заново.
- Установка недостающего engine, настройка моделей, MCP/rules и проверка результата
  входят в согласованный сценарий; пользователь не обязан завершать его другими
  командами вручную.

### 1.2. Антицель

**Не добавлять и не сохранять запреты только потому, что Triss не может доказать
полную безопасность, изоляцию или read-only поведение.**

Обязателен clean cutover:

1. Убрать non-coder запреты для `opencode2`, `omp`, `crush`.
2. Убрать Triss-only ограничение Crush провайдером Z.AI, реализовав необходимые
   provider/config/credential/protocol adapters.
3. Убрать безусловный отказ direct transport для Go/Zen; разрешать конкретный
   native protocol выбранной модели и выполнять запрос, не подменяя engine.
4. Провести изменение через setup, runtime, status, CLI, MCP, тесты и документацию.
5. Вместо отказа из-за неполных гарантий использовать доступный best-effort путь
   и конкретное предупреждение. Доступные защиты при этом сохраняются.

Нельзя завершить задачу формулировкой «остальные engines пока unsupported»,
отключением пунктов меню, молчаливым переходом на OpenCode/Z.AI, fake-success или
превращением существующей реализации в новый обязательный capability gate.

### 1.3. Граница реальных ошибок

Отсутствующий исполняемый файл, ключ, невалидный синтаксис конфигурации, отказ API,
реальная невозможность поддерживаемого native протокола — не то же самое, что
недоказанная безопасность. Сообщать точную причину и способ исправления.

Отсутствие adapter в Triss является задачей реализации, не внешним ограничением.
Если действительно отсутствует внешняя возможность, сохранить точный native
ответ, версии, воспроизводимую команду и оставшийся acceptance criterion;
сообщить владельцу блокер, не объявляя весь план выполненным. Не придумывать
протокол, недостающие credentials или результаты live-проверок.

Защиту, которую пользователь явно потребовал, нельзя молча ослабить. Доступный
best-effort вариант объясняется пользователю; default best-effort не требует
дополнительного opt-in только из-за отсутствия полной гарантии.

Проверки синтаксиса, реальные filesystem errors, отсутствие обязательных данных,
секреты в логах и supply-chain проверки не удалять массово под видом снятия
engine-запретов. Для каждого runtime gate определить, проверяет ли он возможность
выполнения или вводит произвольную политику доступности.

### 1.4. Матрица охвата

| Задачи | Исполнение | Providers |
| --- | --- | --- |
| `ask`, `chat`, `fetch` с вопросом, `write`, `commit-msg`, `review`, `review-shard`, model-backed `exec`, integration summaries, MCP-эквиваленты | `direct`, `opencode`, `opencode2`, `omp`, `crush` | все шесть canonical providers |
| `coder run`, `exec --code`, MCP coder | `opencode`, `opencode2`, `omp`, `crush` | все шесть canonical providers |

Canonical IDs: `openai-compatible`, `zai`, `opencode-zen`, `opencode-go`,
`moonshot`, `kimi-for-coding`. `direct` — существующий HTTP model transport,
а не отдельный native coding CLI; новый autonomous agent loop для него не строить.
Ни один provider нельзя исключить из coding из-за этого различия.

Операции интеграций без model call продолжают обращаться к соответствующим API;
не нужно прогонять создание issue через LLM только ради единой матрицы.

## 2. Подтверждённая исходная точка

Ссылки ниже указывают на существующие файлы. Искать по символам: номера строк
после первых изменений устареют. Перед изменением exported API найти все ссылки
через доступный LSP и перенести всех потребителей в том же изменении.

| Область | Существующая реализация | Что требуется исправить |
| --- | --- | --- |
| Wizard | [config.js](../../src/commands/config.js): `runWizard`, `runStandardWizard`, `runFullWizard` | три расходящихся пути; immediate writes; Standard сбрасывает provider/engine |
| Ввод и env | [secrets.js](../../src/secrets.js): `prompt`, `promptChoice`, `yesNo`, `setVar`, `unsetVar`, `activeEnvFiles` | Enter сохраняет default; нет явного clear; non-TTY подставляет defaults; файл создаётся до проверки target |
| Provider state | [provider-config.js](../../src/provider-config.js): `createProviderConfigSnapshot`, `readProviderConfigSnapshot` | переиспользовать provenance; не строить второй resolver |
| Provider metadata | [provider-registry.js](../../src/provider-registry.js): `listProviderDefinitions`, `getProviderDefinition`, `PROVIDER_CONFIG_ENV_KEYS` | все providers должны быть доступны wizard; общие модели/credentials не дублировать в coder |
| Model selection | [model-selection.js](../../src/model-selection.js): `resolveModelSelection`, `resolveProviderRoute`, `resolveModelRequest` | единое разрешение маршрута и planned effective state |
| Model roles | [model-runtime.js](../../src/model-runtime.js): `resolveTaskRole`, `listModelTaskRoles`, `executeModelTask` | сохранить main/small контракт и explicit model override |
| Projection gate | [model-projection-policy.js](../../src/model-projection-policy.js): `resolveModelProjectionPolicy` | три `supported: false` и throw — не целевой контракт |
| Projection execution | [model-engine-adapters.js](../../src/model-engine-adapters.js): `executeProjectedEngineTask` | уже вызывает общий coder runner; обеспечить все engine branches и корректные ошибки |
| Native transport | [coder-providers.js](../../src/coder-providers.js): `CODER_PROVIDER_REGISTRY`, `resolveCoderProviderRoute`, `buildCoderTransientProviderOverlay` | вынести общие model-specific protocol данные из coder-only слоя |
| Direct transport | [transport-registry.js](../../src/transport-registry.js) | `registry` сейчас всегда бросает `TRISS_DIRECT_ENGINE_REQUIRED` |
| Coder | [coder.js](../../src/commands/coder.js): `validateCoderRunOptions`, `runCoderRun`, `runCrushFlow` | downstream gates, Z.AI hardcodes, projections, default selection и lifecycle |
| Coder setup | тот же файл: `runCoderInit`, `runOpenCode2Init`, `runCoderSetup`, `persistProviderModels`, `ensureEngine` | общий полный setup; выбранный engine сохраняется; OMP/Crush не обрывают wizard |
| Init/rules | [init.js](../../src/commands/init.js): `runInit`, `postInit`; [agent-rules.js](../../src/agent-rules.js): `renderRules` | `init --setup` сейчас пишет rules раньше wizard и теряет scope/target intent |
| MCP install | [install.js](../../src/mcp/install.js): `configPath`, `installEntry`, `showStatus` | учитывать разные host scopes, не делать неявную глобальную запись |
| File transactions | [marker-transaction.js](../../src/marker-transaction.js): `planManagedPath`, `validateFileTransaction`, `applyFileTransaction` | использовать существующую модель managed updates; не заменять пользовательский текст |
| Migration | [migrate.js](../../src/migration/migrate.js): `inspectMigration`, `preflightMigration`, `runMigration` | встроить существующую миграцию, не создавать compatibility readers в runtime |
| Readiness | [status.js](../../src/commands/status.js): `runStatus`; [registry](../../src/integrations/_registry.js): `envReadiness` | различать configured/verified/best-effort/incomplete; оценивать effective state |

Ранее выполненный изолированный CLI smoke уже показал:

- Standard изменяет существующий `opencode-go / opencode` на
  `openai-compatible / direct`.
- Пустой Standard без TTY и ключа возвращает 0 и создаёт Claude MCP/rules.
- Help предлагает `deepseek`, но такой target отвергается; пустой env-файл
  появляется даже до ошибки неизвестного target.

Эти наблюдения — исходные дефекты, а не поведение, которое нужно сохранять.

### 2.1. Downstream места, которые нельзя пропустить

В `src/commands/coder.js` проследить отдельно:

- `validateCoderRunOptions`: `modelProjectionTask`, запрет `agent` для projection,
  принудительный `isolate`, Crush provider check, OMP agent/restrict проверки.
- `runCoderRun`: default `selectionProvider='zai'` для Crush, выбор credentials,
  `transportAudited`, `rawBuiltInRoute`, projection agent, transient config.
- `runCrushFlow`: provider в config, proxy route, env, model selector, usage и
  envelope. Сейчас Z.AI hardcoded в нескольких местах, не только при валидации.
- `opencodeConfigTemplate`, `auditEffectiveOpenCodeConfiguration`,
  `staticOpenCode2Preflight` и `src/opencode2-preflight.js`: отделить JSON/route
  correctness от требований доказанной безопасности.
- OpenCode 2 и OMP branches: run-private dirs, sessions/leases, NDJSON fold,
  timeout/cancel и finally cleanup должны работать и для non-coder задач.

Нельзя выставить `supported: true` и передавать один OpenCode agent всем engines:
OMP не использует тот же `--agent`; Crush имеет другой native config/CLI.

### 2.2. Native Crush: известное и ещё не доказанное

Triss устанавливает `@phpcraftdream/crush`, а не произвольный пакет с именем crush.
Проверенный npm metadata на дату плана: version `0.1.6`, repository URL указывает
на Charmbracelet. Это не доказывает идентичность бинарника upstream tag.

Внешние первичные источники, прочитанные при подготовке:

- [Crush current schema](https://raw.githubusercontent.com/charmbracelet/crush/main/schema.json).
- [Crush upstream v0.1.6 schema](https://raw.githubusercontent.com/charmbracelet/crush/v0.1.6/schema.json).

Обе схемы разрешают arbitrary provider keys, `base_url`, `api_key`,
`SelectedModel.provider`. В current schema есть `openai`, `openai-compat`,
`anthropic`; upstream v0.1.6 перечисляет `openai`, `anthropic`, `gemini`, `azure`,
`vertexai`, но не `openai-compat`. Следовательно, Z.AI-only не следует даже из
общей native schema. Однако wire-протокол фактически установленного fork,
особенно Responses vs Chat, проверить отдельно. Не копировать upstream type
без проверки нужной версии и не вводить exact-version admission gate.

## 3. Пользовательский контракт wizard

### 3.1. Easy

Bare `triss config wizard` в TTY сразу открывает Easy. Не начинать с выбора из
разделов или обязательного вопроса Easy/Advanced. Существующий `--standard`
остаётся явным выбором этого пути; новый alias `--easy` не нужен.
`--advanced` и ненавязчивая ссылка/действие в интерфейсе открывают Advanced.

Типичный первый запуск:

1. **Провайдер и доступ.** Показать рекомендуемый provider или найденный текущий.
   Дать выбрать другой. Запросить credential только если он действительно нужен.
2. **Рабочий инструмент.** Предложить найденный Claude/Codex, разрешить оба или
   пропуск. Это не вопрос про внутренний execution engine.
3. **Краткий итог и применение.** Provider, выбранные модели/engine одной строкой,
   какие внешние установки и host-файлы изменятся. После применения — первая
   рабочая команда и честная отметка проверки.

Модели, endpoint, scope и engine выбираются из существующего effective config
или provider/engine recommendations, а не выпрашиваются у обычного пользователя.
Рекомендации видны в итоге и доступны для изменения в Advanced. Для новой global
установки сохранить привычный global scope, если пользователь не выбрал local.
Флаг `--local` всегда имеет силу и не теряется при переходах между экранами.

Правила выбора:

- Есть явная текущая конфигурация — использовать её; не заменять «рекомендованной».
- Есть одна однозначная конфигурация — предложить её без повторного ввода ключа.
- Один `OPENCODE_API_KEY` не различает Go/Zen: при отсутствии выбора спросить
  provider, а не гадать о тарифе.
- Нет конфигурации — recommendation из registry. Не hardcode личный Muse-модельный
  выбор владельца как новый глобальный default всем пользователям.
- Для engine-backed setup дать завершить установку нужного CLI внутри wizard.
  Не устанавливать все четыре engines «на всякий случай».
- Не показывать env names, protocol/audit термины и security matrix на основном
  пути. Краткое предупреждение показывать только когда оно относится к выбору.
- Не копировать globals в local ради заполнения файла. Наследование — полноценный
  результат настройки, не пропущенное поле.

Проверять краткость реальным прохождением. Не фиксировать в тестах точное число
строк/вопросов: для отсутствующего binary или ключа нужны условные шаги.

### 3.2. Advanced

Разделы появляются только после добровольного входа в Advanced:

- Providers: все шесть, credentials, endpoints/планы, main/small models.
- Выполнение: default engine, coding engine/provider, effort, protection.
- Подключение: Claude/Codex, MCP/rules отдельно, scopes и пути.
- Интеграции: GitHub/GitLab/Jira/Confluence/Linear.
- Рабочие параметры: limits/timeouts/network/usage/update и model transport override.
- Проверка/миграция/исправление незавершённого setup.

Для существующего значения: сохранить, заменить, убрать override. Enter по
умолчанию сохраняет; очистка — отдельное действие, не неоднозначный пустой ввод.
Показывать effective value и источник, secrets маскировать. Shared credentials
спрашивать один раз: Atlassian для Jira/Confluence, OpenCode key для Go/Zen.

Advanced может конфигурировать несколько providers без смены default. Изменение
роли общей provider profile объясняет, какие задачи её используют. Не создавать
отдельную копию main/small моделей для каждого engine.

### 3.3. Targeted и связанные entry points

- Существующие integration targets и `coder` используют те же шаги и apply.
- Добавить все canonical provider IDs как targets. `openai-compatible` сохраняется;
  не возвращать удалённый `deepseek` alias.
- Не сочетать explicit target с `--standard`/`--advanced`; проверить аргументы
  до создания env-файла и иных side effects.
- `triss init --setup` делегирует wizard ДО записи rules; сохраняет target/scope
  intent. `runInit` без setup остаётся операцией установки rules.
- `coder init` и wizard coder вызывают один полный engine setup; ни одна ветка
  wizard не предлагает обязательный второй запуск `coder init`.
- `--force` означает повторно предложить редактирование выбранных полей, а не
  сбросить профиль или разрешить перезапись посторонних host configs.

### 3.4. Non-TTY

Неинтерактивный запуск без явного согласия на применение завершается с понятной
ошибкой до записей. Добавить `--yes`: только применение complete configuration,
собранной из существующих файлов, окружения и явных flags. Никаких secret values
в CLI args; использовать существующий `config set`/stdin/env mechanisms.

- `--yes` не превращает отсутствующий ключ в success и не означает согласие на
  неизвестные глобальные installations.
- Добавить `--agent <claude|codex|both|none>` для явного host intent; non-TTY default
  `none`. Не выбирать Claude молча.
- Отдельное `--install` разрешает показанные/предсказуемые установки отсутствующих
  engines в headless-сценарии. Без него вернуть actionable missing-dependency
  result, не пытаться спросить stdin.
- Не вводить новый формат answer files, отдельный automation server или ещё один
  слой settings. `config set` + wizard `--yes` достаточно для этого изменения.
- Неинтерактивная config-only готовность и отсутствие live-проверки различаются
  в итоговом результате, а не маскируются одним `Done`.

## 4. Конфигурация и общие контракты

Названия новых модулей/полей в этом разделе — проектируемые, не существующие API.
Реализовать их либо объединить с подходящим существующим модулем без изменения
смыслового контракта. Не создавать plugin framework, event bus, persistent
wizard database или общую платформу произвольных профилей.

### 4.1. Единственный источник значений

Использовать существующий immutable provider snapshot и то же precedence:

`explicit request > соответствующий configured default > registry default`;
для каждого persisted поля: `shell > local > global > registry default`.

Wizard хранит отдельно:

- исходный effective snapshot и происхождение значений;
- sparse edits только выбранного scope;
- preview snapshot с этими edits;
- planned effects и результаты применения.

Сохранение `global` не гарантирует изменения effective value при local/shell
shadow. Показать это до применения; не редактировать shell, чужой scope или
host config автоматически. Draft должен обновляться сразу после ответа, чтобы
повторно не спрашивать shared credential.

### 4.2. Defaults без скрытого влияния coder на ask/review

Сохранить provider main/small роли и `TRISS_CONFIG_SCHEMA=2`. Не возвращать
`TRISS_CODER_MODEL`, `TRISS_CODER_SMALL_MODEL`, `TRISS_DEFAULT_MODEL`, worker aliases
и удалённые model-set команды.

Существующие поля:

- `TRISS_DEFAULT_PROVIDER`, `TRISS_DEFAULT_ENGINE` — обычные model tasks.
- `TRISS_CODER_ENGINE` — coding execution; default остаётся существующим native
  coding default, а не автоматически наследует `direct`.

Добавить только необходимые additive settings:

| Новое поле | Смысл |
| --- | --- |
| `TRISS_CODER_PROVIDER` | необязательный coding default; если отсутствует, наследует shared default provider |
| `TRISS_DEFAULT_EFFORT` | необязательное effort для model tasks; отсутствие сохраняет native default |
| `TRISS_CODER_EFFORT` | необязательный coding override; иначе наследование shared effort |
| `TRISS_PROTECT_CREDENTIALS` | сохранённый общий выбор защиты credentials, boolean |
| `TRISS_CODER_PROTECT_CREDENTIALS` | необязательный coding override защиты |
| `TRISS_MODEL_TRANSPORTS` | необязательная JSON map `canonical-provider/native-model -> transport id`; экспертное уточнение протокола, не allowlist моделей |

Зарегистрировать новые поля в одном inventory и реальных readers. Для protection
сохранить три состояния: отсутствует, true, false. Строка `"false"` не truthy opt-in.
Добавить CLI `--no-protect-credentials` там, где persisted true иначе невозможно
перекрыть. Существующее explicit MCP boolean false также должно работать.
Не менять действующий public alias protection вне необходимого cutover; при
конфликте старого truthy alias с новым значением сохранить документированный
принцип не ослаблять явно запрошенную защиту.

Coding provider precedence: explicit model prefix / explicit provider по текущему
контракту > `TRISS_CODER_PROVIDER` > `TRISS_DEFAULT_PROVIDER` > registry default.
Модели по-прежнему берутся из canonical provider profile. Изменение coding setup
НЕ вызывает безусловную запись `TRISS_DEFAULT_PROVIDER`.

`TRISS_MODEL_TRANSPORTS` не хранит credentials/endpoints, не создаёт provider alias
и не ограничивает native catalogue. Применяется к exact qualified model, а не ко
всем моделям по похожему имени. Нельзя молча отправить Responses-модель в Chat
Completions, потому что новое имя не находится в hardcoded таблице.

### 4.3. Предлагаемые небольшие модули

| Новый модуль | Ответственность и публичные функции |
| --- | --- |
| `src/provider-model-transport.js` | `resolveProviderModelTransport(...)`: общие model-specific transport данные/metadata для direct и native adapters |
| `src/setup/configuration.js` | `listSetupFields()`, `readSetupState(...)`, `applyDraftToSnapshot(...)`; inventory, effective values, sparse set/unset edits |
| `src/setup/engines.js` | `planEngineSetup(...)`, `applyEngineSetup(...)`; общий engine setup для coder init и wizard, без внутренних prompts |
| `src/setup/plan.js` | `buildSetupPlan(...)`, `applySetupPlan(...)`; preview, planned files/actions, применение и partial outcome |
| `src/setup/readiness.js` | `inspectSetup(...)`; общий read-only результат для wizard/status/init |
| `src/setup/wizard.js` | `runSetupWizard(...)`; Easy/Advanced/targeted presentation над общими state/plan APIs |

Не переносить весь `coder.js` сразу. Извлекать только необходимые setup/native
projection boundaries, оставляя runner lifecycle в существующем месте до тех пор,
пока извлечение действительно не нужно. Старые wrapper-реализации setup удалить
после миграции callers, а не оставлять второй путь.

Логическая форма данных (JS objects, не новые публичные schema files):

- `SetupState`: original snapshot, selected scope, existing host installations,
  engine availability, migration state; secrets не попадают в renderer напрямую.
- `SetupDraft`: sparse `set`/`unset`, selected provider/engine actions, host actions,
  requested validation. Это не копия всего process.env.
- `SetupPlan`: proposed values + sources, file changes, external installation
  actions, limitations, real blockers. Renderer получает redacted projection.
- `SetupResult`: `status` = `ready | incomplete | cancelled`, per-component state,
  applied/unchanged/failed actions и warnings.
- Per-component readiness: `configured`, `available`, `verification` =
  `not-run | passed | failed`, `executionMode` = `normal | best-effort`, reasons.

Best effort — не `incomplete`. Пропуск optional integration — не error. Отсутствие
обязательного credential выбранного сценария — incomplete. Отсутствие live-check
не равно failed check. Произвольный `blocked-by-policy` status не добавлять.

### 4.4. Полный inventory Advanced

Построить из реальных readers; docs и `NON_SECRET_CODER_STORE_KEYS` сами по себе
не доказывают, что настройка работает.

| Группа | Поля/действия | Примечание |
| --- | --- | --- |
| Provider profiles | каждый credential/endpoint/model/smallModel из registry | все шесть; Z.AI plan/endpoint; OpenAI-compatible custom endpoint |
| Defaults | shared provider/engine, coder provider/engine, effort/protection | реальные readers и explicit override precedence |
| Model transport | `TRISS_MODEL_TRANSPORTS` | Advanced manual recovery при отсутствии catalogue metadata |
| Atlassian | `ATLASSIAN_BASE_URL`, `ATLASSIAN_EMAIL`, `ATLASSIAN_API_TOKEN` | единый credential group Jira/Confluence |
| GitHub | `GITHUB_TOKEN`, обнаруженная gh auth | не переписывать автоматически bootstrap token в .env |
| GitLab | `GITLAB_TOKEN`, `GITLAB_URL` | endpoint editable |
| Linear | `LINEAR_API_KEY`, `LINEAR_API_URL` | endpoint editable |
| Engine installation | четыре native engines, installed/current minimum/install action | newer versions принимаются; никаких exact pins ради audit |
| Engine tuning | `TRISS_CODER_*_VERSION`, `TRISS_CODER_CRUSH_RESTRICT` | показать поддерживаемые runtime knobs, не фиктивные поля |
| Requests/network | `TRISS_REQUEST_TIMEOUT_MS`, `TRISS_HTTP_TIMEOUT_MS`, `TRISS_HTTP_MAX_BYTES`, `TRISS_FETCH_MAX_BYTES` | единицы и parser из runtime |
| Review | `TRISS_REVIEW_SINGLE_MAX_BYTES`, `TRISS_REVIEW_SHARD_MAX_BYTES`, `TRISS_REVIEW_TOTAL_MAX_BYTES`, `TRISS_REVIEW_MAX_SHARDS` | ограничения согласованы с consumers, не отдельные magic numbers в wizard |
| Corpus | `TRISS_FILE_MAX_BYTES`, `TRISS_CORPUS_MAX_BYTES`, `TRISS_GLOB_MAX_FILES` | реальные bounds, без новых ограничений provider/engine |
| Paths/network policy | `TRISS_RESTRICT_PATHS`, `TRISS_ALLOW_PRIVATE_NETWORKS`, явный root override | не сохранять session/project root глобально автоматически |
| Usage/privacy | `TRISS_USAGE_LOG`, `TRISS_USAGE_LOG_CWD`, `TRISS_USAGE_LOG_MAX_BYTES` | boolean/size semantics из runtime |
| Pricing | существующее семейство `TRISS_PRICE_<MODEL_ID>` | динамические model keys, без дублирующего model registry |
| Update | `TRISS_UPDATE_CHECK` | auto-check preference, не обновление всех engines без выбора |
| Agent integration | MCP и rules для Claude/Codex, выбранный scope | paths показаны заранее; preserve unrelated content |
| Maintenance | migration, validation, repair incomplete setup | использовать существующие migration/install APIs |

Исключить из редактируемого persisted inventory: correlation `TRISS_PARENT_CALL_ID`,
run IDs/leases, автоматически установленные XDG/PI directories, bootstrap/probe
results, обнаруженные binary paths как постоянные pins, test-only env knobs.
`TRISS_CODER_SESSION_CAP` найден в store allowlist, но reader не подтверждён:
проверить consumer; inert knob не рекламировать. Либо удалить устаревшее описание,
либо реализовать действующий documented contract в рамках соответствующей задачи.
Не добавлять бессмысленное поле только для галочки «настраивает всё».

## 5. Execution policy: best effort без подмены выбора

### 5.1. Transport и гарантии — разные данные

Отделить две характеристики:

1. Native route: provider/model, protocol, endpoint, auth, engine config mapping.
2. Available guarantees: tool restrictions, credential handling, isolation.

`transportAudited: false` не означает «пользователь не имеет права запустить».
В raw/native mode использовать собственный resolver engine, когда он умеет этот
provider/model. Для direct получить реальный protocol из общего metadata или
explicit override. Не маркировать неизвестный протокол как «unsafe provider».

Не использовать safety-рейтинг для замены engine. Если user выбрал OMP, response
metadata и фактический child должны быть OMP, даже если OpenCode лучше ограничивает
инструменты. Capability assessment объясняет ограничения, а не формирует whitelist.

### 5.2. Non-coder tool intent

Для анализа стараться ограничить tools и доступ к ambient context имеющимися
средствами каждого native engine. Не отключать работающие read-only настройки
OpenCode только ради унификации. Для OMP/Crush/OpenCode 2 применить соответствующие
native knobs, где они существуют; где гарантия не доказана — best-effort warning.

Не заявлять, что prompt с инструкцией «не меняй файлы» является sandbox. Не
подменять указанный пользователем custom agent другим молча. При несовместимости
agent/tool intent с гарантией показать конкретное ограничение и выполнить best
effort, если строгая гарантия не была явно запрошена.

Context-only model call не должен требовать git repository только из-за старого
coder isolation path. Вне git использовать доступную run-private рабочую директорию
или другой существующий best-effort execution path с предупреждением. Lifecycle,
результат и cleanup остаются настоящими, не no-op.

### 5.3. Warning contract

Переиспользовать существующие warnings в normalized result/envelope и MCP.
Не вводить второй telemetry/result формат. Кратко сообщать engine, ограничение и
практический эффект. Не выводить ключи, полные credential-bearing URLs, весь env
или user config.

- CLI: warnings в stderr, stdout сохраняет machine-readable/text contract.
- MCP: warning остаётся в structured result; warning не превращает success в error.
- Wizard: одна concise сводка relevant limitations, детали по запросу.
- Один и тот же limitation не печатать на каждом внутреннем шаге.
- При настоящем execution error сохранять и причину, и уже собранные warnings.
- Неполная usage — явно unknown/partial, не выдуманные нулевые счётчики.

## 6. План работ с зависимостями

Каждый пункт ниже — самостоятельный проверяемый пакет, не разрешение остановиться
после части общего результата. Новые имена API из раздела 4 помечены как proposed.
Перед началом пункта прочитать перечисленные symbols и действующие тесты целиком
в относящихся к задаче блоках, не редактировать по одной строке из поиска.

| Пакет | Зависит от | Результат |
| --- | --- | --- |
| P01 | — | единое model-specific transport разрешение |
| P02 | P01 | direct Go/Zen и generic Crush providers |
| P03 | P01, P02 | все native engines для non-coder, best-effort вместо gates |
| P04 | P03 | CLI/MCP result, lifecycle и warnings end-to-end |
| P05 | — | inventory и согласованные persisted defaults |
| P06 | P02, P03, P05 | полный общий engine setup/install |
| P07 | P05, P06 | draft, preview и безопасное применение |
| P08 | P07 | Easy default |
| P09 | P07, P08 | полный Advanced и targeted paths |
| P10 | P04, P07, P09 | init/status/MCP wiring/migration/readiness |
| P11 | P04, P08, P09, P10 | регрессионная и реальная end-to-end проверка |
| P12 | P11 | docs/site/package cleanup и окончательная приёмка |

P01–P04 и P05 независимы по смыслу, но оба затрагивают provider snapshot/selection.
Если работают несколько агентов, Main/integration owner владеет общими registry,
selection, CLI и `coder.js`; sibling patches туда не применяются одновременно.
Не запускать full suite, пока concurrent edits не интегрированы. Для одного
исполнителя последовательность таблицы безопасна.

### P01. Общее разрешение native transport

**Читать:** `provider-registry.js`, `provider-config.js`, `model-selection.js`,
`coder-providers.js`, три `src/transports/*` adapter, model catalogue helpers в
`commands/coder.js`, `opencode-catalogue.js`.

**Изменить:**

1. Вынести model-specific Zen/Go protocol mapping из coder-only registry в
   proposed `provider-model-transport.js`. Оставить один источник protocol/auth/
   package metadata для direct, OpenCode 1/2, OMP и Crush.
2. `resolveProviderRoute` возвращает concrete model route либо native-resolvable
   metadata. Credentials/endpoint продолжают происходить из canonical snapshot.
3. Поддержать актуальное catalogue metadata без permanent allowlist проверенных
   model names. Offline сохранённый выбор не отбрасывается из-за ошибки каталога.
4. Добавить `TRISS_MODEL_TRANSPORTS` exact model override для Advanced/manual setup;
   проверить JSON/object shape и transport identifier, не трактовать его как
   разрешение только перечисленных моделей.
5. Для unknown model с native resolver не блокировать raw launch. Для direct без
   достаточного protocol metadata дать конкретное исправление через override,
   не молча гадать о Chat/Responses и не переключать на другой engine.
6. Native OpenCode Go/Zen request semantics из `3b67eb0` сохранить: provider identity,
   model identity, headers и соответствующий protocol не теряются при extraction.

**Приёмка:** один provider с main Responses-моделью и small Chat-моделью реально
использует разные endpoints/protocols; новая модель из metadata не требует
добавления в security whitelist; explicit override не меняет billing identity.

**Проверка:** focused `provider-contract`, `provider-config`,
`coder-provider-registry`, `transports` tests; local mock HTTP server проверяет
observable protocol response, provider error и usage, а не только поля config.

### P02. Direct Go/Zen и provider-neutral Crush

**Читать:** `transport-registry.js`, `coder-engine-registry.js`,
`coder-engines/crush.js`, `runCrushFlow`, Crush selection/setup branches в
`commands/coder.js`, `coder-credential-proxy.js`; native schema источники §2.2.

**Изменить:**

1. Удалить unconditional `registry -> TRISS_DIRECT_ENGINE_REQUIRED`; dispatch
   через resolved concrete transport P01 с configured endpoint и canonical key.
2. Убрать Crush-only provider metadata/checks/default forcing. Выбранный provider
   должен дойти до credential selection, proxy route, native config, model argv,
   response envelope и usage. Не оставлять `zai/` prefix в generic branch.
3. Обобщить `buildCrushProtectedProviderConfig`, runtime config и spawn env по
   resolved route. Сохранить selected-secret-only forwarding и native variable
   references вместо записи настоящих ключей в generated JSON.
4. Установить actual config mapping поддерживаемого `@phpcraftdream/crush` через
   его установленную версию, `run --help`, schema/source и native request smoke.
   Для Chat/Responses/Anthropic доказать нужный wire format, а не только JSON parse.
   Если native API нуждается в protocol bridge, реализовать bounded bridge на
   имеющихся transport/proxy primitives без provider/model substitution.
5. Не hardcode одинаковый `type` всем версиям из upstream schema. Принимать newer
   версии; ветвление по реально различающемуся contract допустимо, denylist новых
   версий — нет. Не повышать minimum исключительно чтобы избежать adapter work.
6. Убрать обязательный protected-proxy режим Crush как запрет альтернативы, если
   raw native execution технически возможен. Доступная защита может оставаться
   рекомендацией; explicit пользовательский выбор соблюдается.
7. Перенести все callers старых Z.AI-specific helpers; obsolete exports и тесты
   без действующего контракта удалить, не оставлять compatibility implementation.

**Приёмка:** direct Go/Zen получает реальный ответ; Crush выполняет не-Z.AI
запрос с правильной credential/model identity; при API 401/429 приходит реальная
ошибка, а не Z.AI fallback. Все шесть providers имеют реализованный Crush route.

**Проверка:** `transports.test.js`, `coder-crush.test.js`,
`coder-provider-registry.test.js` и isolated CLI smoke с native Crush и локальным
HTTP endpoint. Чистый echo mock вместо исполнения native config не является
доказательством generic Crush support.

### P03. Все engines для non-coder и снятие downstream policy gates

**Читать:** `model-projection-policy.js`, `model-engine-adapters.js`,
`validateCoderRunOptions`, `runCoderRun` и native branches, `opencode2-preflight.js`,
`provider-security.js`, `coder-engines/omp.js`, `coder-engines/opencode2.js`.

**Изменить:**

1. Projection policy описывает available guarantees/config и limitations, а не
   `supported: false` для известных engines. Unknown engine typo остаётся ошибкой.
2. Проводить selected task/provider/model/effort/protection через все native branches.
   Не прикреплять OpenCode-only agent к OMP или Crush.
3. Сделать best-effort execution доступным при невозможности доказать restrictive
   tool policy, чистый merge agents/plugins, полную worktree или credential isolation.
   Рабочий OpenCode restriction не удалять; неудачный audit превращать в limitation
   там, где он проверяет только гарантию, а не actual launch correctness.
4. Отдельно классифицировать OpenCode 2 checks unrelated provider definitions,
   user agents/plugins, custom tools, shell policies и provenance. Не оставлять
   скрытый security refusal после успешного выбора engine в wizard.
5. `provider-security.js`: syntax validation отделить от advisory provenance/
   transport-security assessment. Например, более высокий credential scope при
   local endpoint или выбранный HTTP endpoint не маскировать как невозможность
   provider execution. Раскрыть конкретный риск без утечки credential; preserve
   explicit user intent и существующие несвязанные guards для fetched content.
6. Для model calls вне git обеспечить настоящий execution path без искусственного
   требования coder worktree. Не создавать durable coder session без необходимости.
7. Если optional параметр не имеет native аналога, не запрещать весь engine:
   применить поддерживаемую эквивалентную настройку либо предупредить о реально
   неприменимом параметре. Нельзя молча игнорировать выбранный provider/model.
8. Изменить obsolete unsupported-projection assertions в `model-runtime.test.js`.
   Удалить implementation-pinning policy table test вместо перепривязки к новой
   таблице; сохранить поведенческие regression scenarios.

**Приёмка:** `ask` и `review` реально запускаются через OpenCode 2/OMP/Crush;
вне git model call не отвергается; невозможность restrictive policy даёт warning
и usable result; actual invalid JSON/invalid argv/API error остаются честными.

**Проверка:** `model-runtime.test.js`, соответствующие `coder-opencode2*`,
`coder-omp-adapter`, `coder-crush`, `provider-security` и best-effort tests.
Для каждого engine отдельно exercise доступных ограничений и degraded path.

### P04. Output, warnings, timeout, cancellation, usage

**Читать:** `executeProjectedEngineTask`, `createExecutionResult`, native event
folds, `spawnEngine` callsites, `mcp/handlers.js` `callModel`, `mcp/tools.js`,
`mcp/server.js`, `model-usage.js`, CLI model command handlers.

**Изменить:**

1. Один normalized result для всех engines. Пустой/malformed envelope, native
   failure, timeout и cancellation не превращаются в successful partial text.
2. Сохранить final text, реальные finish reason, warnings и partial/unknown usage.
   Ошибка, содержащая partial text, не считается success только из-за текста.
3. Передавать abort/timeout от CLI/MCP до child и cleanup. Отозвать proxy, закрыть
   processes/files и освободить lease при всех выходах. Использовать существующий
   lifecycle; не добавлять отдельный process supervisor для model tasks.
4. Streaming для engine без потокового вывода может честно вернуть final chunk;
   не имитировать live streaming и не ломать final structured result.
5. MCP model tools и CLI entrypoints должны иметь одинаковый выбор execution,
   независимо от прежней tool-readiness эвристики. Missing credentials конкретного
   default не скрывают tool, если выбранный explicit route настроен.
6. Canonical usage/billing identity сохраняется; forwarded OpenCode usage не
   записывается второй раз из-за wrapper. Не считать unknown usage нулевой.

**Приёмка:** success+warning доступен как success в MCP; native failure не скрыт;
cancel останавливает child и не оставляет lease/proxy; stdout CLI не загрязнён
warnings. Provider/model/engine в результате соответствуют фактическому запуску.

**Проверка:** `mcp-handlers`, `mcp-tools`, `mcp-server-cancellation`,
`command-runtime-cutover`, `model-runtime`, затронутые usage suites. Сценарии
failure/cancel/missing usage ценнее нового теста, проверяющего простое forwarding.

### P05. Inventory, effective state и persistable defaults

**Читать:** `provider-registry.js`, `provider-config.js`, `model-selection.js`,
`config.js`, `config-defaults.js`, integration manifests, `secrets.js`,
`resolveCoderCredentialMode`, `persistProviderModels`.

**Изменить:**

1. Proposed `setup/configuration.js` собирает §4.4 из provider registry,
   integration metadata и реальных runtime parsers. Секретность не определяется
   только regex по имени. Extensions с корректными manifests не теряются.
2. Добавить additive поля §4.2 и consumers. Расширить snapshot один раз; в CLI/MCP
   не собирать собственное precedence из process.env по месту.
3. Исправить `persistProviderModels`: менять только выбранную provider profile;
   shared default/coder default изменяются отдельными explicit actions.
4. Engine selection сохраняется в правильный default. `--coder-engine omp` setup
   не оставляет последующий bare coder на OpenCode.
5. Effort public vocabulary брать из contract: `low/medium/high/xhigh/max`.
   Optional absence означает native default; не вводить старое `minimal`.
6. Boolean protection parsing централизовать. Обновить все entrypoints, которые
   сейчас default-ят missing value в false до обращения к resolver.
7. Implement sparse set/unset с planned snapshot и source annotations; `current`
   не является только содержимым destination .env. Не мутировать process.env
   посреди диалога для фиктивного simulation состояния.
8. Shared credential groups вычисляются по field identity. GitHub bootstrap и
   file credentials одинаково видны readiness, но bootstrap не копируется на диск.

**Приёмка:** coder-only смена provider/engine не меняет ask/review; отсутствие
coder override наследует shared provider; explicit false перекрывает persisted
protection true; локальная очистка override возвращает global значение; модели
общего provider profile не дублируются по engines.

**Проверка:** focused provider-config/model-selection/config/credentials tests;
регрессии precedence и boolean false. Не создавать source-text tests для inventory.

### P06. Общий полный engine setup и installation

**Читать:** `runCoderInit`, `runOpenCode2Init`, `runCoderSetup`,
`runCoderSetupUnlocked`, `ensureEngine`, model-selection/catalog helpers,
engine registry и engine version/install APIs.

**Изменить:**

1. Proposed `setup/engines.js` принимает resolved intent/state и возвращает plan
   без prompts и преждевременной записи. CLI adapters собирают user intent снаружи.
2. Общий apply делает version detection/install, provider/model projection и
   необходимые native config действия. Все четыре engines доводятся до конца.
3. Crush wizard больше не сохраняет только Z.AI key с последующим throw о
   необходимости `coder init`. OMP получает полный выбор profile/roles и сохранение
   intent, даже если его runtime config остаётся run-private.
4. OpenCode 1/2 setup не должен взаимно портить shell/agent policy shared
   `opencode.json`. Runtime-only differences уходят в transient/run-scoped overlay;
   persistent общие provider данные не дублируются.
5. Missing binary: построить точную install action из существующего engine install
   contract. Easy включает её в общее подтверждение; Advanced позволяет изменить
   или пропустить. Headless выполняет только с `--install`.
6. Сохранять supported-minimum-or-newer политику. Для O2 beta не вводить точный build
   pin, сверку help prose или требование несуществующего `--variant`; effort mapping
   остаётся native `provider/model#variant` там, где это текущий contract.
7. Не поднимать minimum ради непройденного safety audit. Если installation/runtime
   реально несовместимы, предложить корректное обновление с native причиной.
8. API/model catalogue failures не стирают выбор и не заставляют отказаться от
   manual model ID. Показать stale/unverified metadata отдельно от execution error.
9. Удалить obsolete обязательные safety-opt-ins `--allow-unverified`,
   `--allow-unsafe-bash`, `--allow-best-effort-caller-worktree` и соответствующие
   внутренние gates после введения default best-effort. Перенести CLI/MCP callers,
   help и тесты; не оставлять скрытый обязательный opt-in под новым именем.
   Это не отменяет явно запрошенные пользователем isolation/protection guarantees.

**Приёмка:** любой engine настраивается одним wizard; выбор provider и engine
persisted; поддерживаемая более новая версия не заменяется старой; отказ от
installation даёт incomplete с точной причиной, не generic success.

**Проверка:** existing coder init/version tests после cutover; новый observable
wizard->bare coder scenario для OMP/Crush; manual model/offline catalogue case.

### P07. Draft, preview, file transactions и recovery

**Читать:** `secrets.js`, `marker-transaction.js`, MCP install planning/writers,
`runMigration` transaction patterns, `setup/configuration.js`, `setup/engines.js`.

**Изменить:**

1. Proposed `setup/plan.js`: argument validation и read/discovery до mkdir/env
   creation. Все interactive ответы накапливаются в draft, не `setVar` на месте.
2. Из существующего env formatter выделить pure multi-key patch: сохранить
   комментарии/порядок/quoting, поддержать unset и unrelated keys. Не создавать
   второй dotenv parser рядом с `parseEnvText`.
3. Файловые изменения планируются целиком; перед replace проверить, не изменился
   исходный файл. Атомарно заменить отдельные файлы; откатить только свои изменения
   при apply failure, не затирать concurrent user edits.
4. Для local env защита прав и `.gitignore` входят в тот же согласованный apply,
   а не выполняются только в конце успешного coder setup. Изменения `.gitignore`
   идемпотентны и не удаляют другие строки.
5. MCP JSON/TOML и managed rules применять существующими корректными writers.
   Если для общего preview нужно извлечь pure planning helper — извлечь его;
   не писать второй TOML parser и не заменять весь host config шаблоном.
6. Отмена multiselect/hidden input/обычного input одинаково прекращает wizard;
   не трактовать cancel как «пустой выбор, продолжай core». Восстановить terminal
   state. До apply изменения файлов отсутствуют.
7. Внешние package installs не объявлять частью общей атомарной транзакции:
   installation отдельно, затем file apply; при неудаче честно перечислить уже
   установленные компоненты и не удалять ранее существовавшие пакеты.
8. После file apply пересчитать effective state реальным resolver. Partial
   failures дают per-action outcome и понятное продолжение при новом запуске,
   без отдельной persistent wizard database и секретных debug dumps.

**Приёмка:** invalid target и cancel не создают `.env`; shared credentials
пишутся один раз; failure после установки не теряет сведения о сделанном;
concurrent edit не затирается; local secret file не остаётся unignored из-за
поздней ошибки post-setup.

**Проверка:** focused transaction/secret/config tests с временным HOME/project;
поведенческие cancel-before-apply, concurrent edit, partial external action,
managed-content preservation. Не ограничиваться проверкой вызова `setVar`.

### P08. Easy default

**Читать:** новый shared setup API, `runWizard`, `runStandardWizard`,
`chooseMode`, `chooseAgentTarget`, существующие prompt helpers.

**Изменить:**

1. В proposed `setup/wizard.js` реализовать §3.1 поверх state/draft/plan.
2. Bare interactive invocation выбирает Easy без дополнительного mode prompt.
   Advanced доступен из этого пути без потери draft; --standard/--advanced
   остаются проверяемыми explicit flags.
3. Убрать hardcoded записи openai-compatible/direct/schema в Standard body;
   schema/defaults устанавливает общий plan только для нужной конфигурации.
4. Найденные credentials/model/engine choices переиспользуются. Не спрашивать
   main/small/effort, если пользователь не открыл дополнительные параметры.
5. Agent host selection допускает skip. Install summary показывает actual scope
   и файлы; Codex global MCP не маскируется словом Project.
6. Итог содержит настроенный маршрут и первую команду. Best-effort limitations
   короткие; незадействованные интеграции не перечисляются как список проблем.
7. Удалить старые Standard-specific auto-install/postSetup ветки после миграции.

**Приёмка:** обычный пользователь подключает доступ и начинает работу без
settings dashboard; rerun ничего не сбрасывает; обнаруженный конфиг не превращает
Easy в анкету; выбранный не-default engine не заменяется ради безопасности.

**Проверка:** настоящий PTY-проход fresh setup и rerun, включая secret masking,
Enter, изменение provider и agent skip. Скрин/terminal transcript без секретов —
обязательное доказательство UI; unit tests prompt mocks его не заменяют.

### P09. Advanced, targeted и headless CLI

**Читать:** `bin/triss.js` config wizard registration, manifests, existing
`runFullWizard`, новый inventory/wizard; CLI config help/completion consumers.

**Изменить:**

1. Advanced показывает группы §3.2 и весь действующий inventory §4.4, а не только
   `CORE_MANIFEST` и credential subset coder. Typed inputs и defaults из общего
   metadata; arbitrary provider/engine строки больше не сохраняются без parsing.
2. Для модели: catalogue search/select при наличии metadata, manual ID всегда
   доступен; main/small labels объясняют задачи; опция одной модели обеим ролям.
3. Для поля: keep/replace/unset; source и shadow display. Не показывать секрет
   ради помощи в конфликте scopes.
4. Target resolution включает canonical provider IDs. Старый `deepseek` help,
   «presets» и «one model only» удалить; не возвращать obsolete aliases.
5. Добавить `--yes`, `--agent`, `--install` из §3.4; конфликтующие flags и неполный
   headless draft отклоняются до writes. Не добавлять secret arguments.
6. Сохранить `--coder-engine`, `--coder-provider`, `--coder-protect-credentials`
   intent и общий credential resolver; setup flags не обходят shared persistence.
7. Обновить completion/help generated surfaces, где они существуют. Не держать
   список providers отдельно в prompt, CLI help и runtime.

**Приёмка:** все выбранные разделы действительно применяются; Jira+Confluence
не спрашивают одно и то же дважды; provider-target не заставляет настраивать
OpenAI-compatible; headless не устанавливает Claude по умолчанию и не виснет.

**Проверка:** config-commands/wizard regressions; PTY Advanced с переходом назад,
clear override, shared credential и manual model; headless CLI real process.

### P10. Readiness, init, status, migration и agent wiring

**Читать:** `commands/init.js`, `commands/status.js`, `agent-rules.js`,
`commands/mcp.js`, `mcp/install.js`, integrations `_registry.js`, migration API.

**Изменить:**

1. Proposed `setup/readiness.js` принимает effective state и optional probe
   results. `status`, wizard и post-init не вычисляют разные понятия готовности.
2. Readiness относится к выбранному route, а не условию «есть любой API key».
   Best effort остаётся доступным; отсутствие network verification не error.
3. Исправить `init --setup` routing до writes и сохранить выбранные scope/target.
   Исключить рекурсию wizard -> init --setup -> wizard.
   Сохранить existing init scope semantics: без `--global` — project/local,
   с `--global` — global. Новый `--local` alias для init не требуется.
4. MCP/rules reuse writers. `renderRules` проверяет relevant scope, не только
   global MCP. Preserve unrelated settings и текст вне managed markers.
5. Claude local MCP имеет project root; global MCP не получает frozen cwd.
   Для Codex использовать реально поддерживаемый host scope; если только global,
   показать это в summary, не придумывать local config и не запрещать setup.
6. Перед обычным draft использовать `inspectMigration`; при legacy state
   предложить существующую canonical migration, показать её эффекты, затем
   перечитать snapshot. Не записывать schema2 поверх немигрированных данных.
7. Migration failure/conflict/cancel не запускает частичный новый setup.
   Существующий cleanup resume остаётся доступен, не меняется на новый формат.
8. Validation по желанию: static/effective checks всегда; live API/model call
   только с понятным user intent, без платного запроса каждому provider.

**Приёмка:** wizard/status/MCP readiness согласованы; project/global semantics
не расходятся; migrated config реально используется; green Done не предшествует
поздней ошибке host installation.

**Проверка:** init, MCP install/Codex transaction, migration, status suites и
isolated `init --setup -> status -> ask` smoke.

### P11. End-to-end regression и реальные запуски

Выполнить матрицу §7. Покрыть не только adapter unit tests: реальные CLI commands,
MCP requests, child lifecycle и terminal UX. Новые постоянные tests только там,
где они защищают от правдоподобной регрессии; не создавать snapshot help-текста,
проверки исходников или сотни строк, проверяющих копирование полей.

До удаления obsolete tests определить, какой контракт они защищали. Удалить
assertions «OMP запрещён»/«Crush всегда Z.AI»/«wizard Crush всегда incomplete»;
сохранить или перенести реальные error/lifecycle/credential masking проверки.
Не использовать blanket skip или снижение coverage threshold для зелёного CI.

Если native engine/credential недоступны, не писать «live passed». Можно доказать
protocol behavior локальным endpoint и supported binary; paid provider checks
отдельно указать как не выполненные. Недоказанный обязательный native route
остаётся незавершённым acceptance criterion, не новым unsupported policy.

### P12. Документация, clean cutover и окончательная приёмка

После работающих smoke-сценариев:

1. Обновить README quickstart, `.env.example`, `docs/configuration.md`,
   `docs/cli-reference.md`, `docs/mcp.md`, `docs/security-model.md`,
   `docs/reliable-delegation-contract.md`, relevant `docs/engines/*` и integration
   docs. Удалить текущие утверждения о запрете O2/OMP/Crush non-coder и Z.AI-only
   Crush; не переписывать исторические планы как будто это было реализовано раньше.
2. Согласовать нормативные security/threat-model assertions с ADR там, где они
   обещают запрет при неполных execution guarantees. Удалить временное описание
   «только план, gates ещё действуют» из current docs после реальной реализации.
3. Обновить `templates/claude*.md`, `templates/codex*.md`, сайт
   `site/src/data/commands.js`, getting-started/docs/coder pages, где описаны
   изменившиеся команды и engine availability.
4. Для новых packaged modules/docs проверить `package.json` files,
   `scripts/package-contents-manifest.json`, standalone/package acceptance.
   Проверить, что ссылки из packaged docs доступны в пакете или ведут на repo URL.
5. Обновить generated defaults штатным `npm run docs:defaults` при изменении
   источника. Исправить относящиеся к работе устаревшие effort/limit descriptions
   по реальным readers, без отдельного несогласованного числа в wizard.
6. Записать user-visible changes в CHANGELOG Unreleased. Удалить obsolete setup
   implementations, dead manifests/hooks, unused aliases/comments и throwaway
   fixtures/scripts. Не удалять пользовательские configs/engines/credentials.
7. Полные проверки выполнить один раз после интеграции. Commit с DCO sign-off;
   push/PR только когда это входит в поручение пользователя.

## 7. Матрица приёмки и команды

### 7.1. Обязательные сценарии

| ID | Сценарий | Ожидаемый наблюдаемый результат |
| --- | --- | --- |
| A01 | fresh Easy с доступным provider | краткий setup, сохранённый usable route, первая команда работает |
| A02 | rerun Easy на Go/Muse/OpenCode или другом явном выборе | provider/model/engine не сбрасываются |
| A03 | Easy без нужного credential | запрос ключа; пропуск даёт incomplete, не false success |
| A04 | Easy с отсутствующим выбранным engine | установка внутри wizard по intent; отказ не выдаётся за readiness |
| A05 | Advanced, все provider profiles | каждый profile сохраняется и разрешается реальным runtime |
| A06 | Jira+Confluence, Go+Zen credentials | shared keys вводятся один раз, unrelated fields сохранены |
| A07 | shell/local/global конфликт + unset local | source виден; shell не переписан; global восстановлен наследованием |
| A08 | cancel на разных prompts и invalid target | до apply ни env, ни MCP/rules не созданы |
| A09 | concurrent file change, installation/file failure | чужие edits сохранены, partial effects названы, rerun продолжает корректно |
| A10 | headless без --yes; complete --yes; incomplete --yes | нет неявных writes/install; complete применён; incomplete nonzero |
| A11 | local/global Claude и Codex, agent none | actual host paths показаны; global MCP не pinned к project; unrelated content сохранён |
| A12 | init --setup и targeted wizard | тот же setup/persistence, без двойных prompts/записей и потери scope |
| A13 | legacy migration, conflict, resume | canonical resolver использует результат; conflict не затёрт новым schema2 |
| A14 | ask/review через O2/OMP/Crush | настоящие ответы на selected engine, warning вместо safety prohibition |
| A15 | каждый native engine × шесть providers | provider/model/credential identity правильны; нет forced zai/opencode |
| A16 | direct Go/Zen, разные native protocols | запрос приходит в правильный API shape; нет unconditional registry error |
| A17 | manual/new model, offline catalogue | сохранённый/manual выбор доступен; metadata limitation не становится denylist |
| A18 | non-coder вне git, доступная/неполная изоляция | реальный execution с честными ограничениями, без fake worktree requirement |
| A19 | MCP success+warning, native failure, timeout, cancel | корректные statuses, warnings, cleanup, no false success |
| A20 | partial/missing usage, native provider error | usage не выдумана, billing identity сохранена, duplicate record отсутствует |
| A21 | coding-only defaults/protection overrides | ask/review не меняются; explicit false/true и отсутствие различаются |
| A22 | новый compatible binary/new model | нет точного pin, help-prose gate или security allowlist для model |

A15 покрывает provider/engine combinations на уровне настоящего native adapter
и protocol integration. Не требуется 24 платных запроса без согласия пользователя;
локальный protocol server и реально установленный binary допустимы. Но mock
`runCoderRun => готовый JSON` не доказывает native support и не закрывает A15.

### 7.2. Подготовка проверок

Выполнять в implementation worktree. Не использовать реальные HOME/project
конфиги для mutation tests. Создать временные HOME/project/XDG dirs; передавать
child allowlisted env с PATH, HOME, нужными fixture settings и
`TRISS_UPDATE_CHECK=0`. Не копировать весь process.env со всеми credentials.

Для interactive verification использовать настоящий PTY, а не newline pipe:
`prompt()` различает TTY/non-TTY. В tool environment long-lived PTY запускается
штатным process manager. Сохранить redacted transcript результата, убрать temp
fixtures после завершения.

Установка dependencies — `npm ci --ignore-scripts`, если node_modules отсутствует.
Не запускать project-wide suite для каждого небольшого шага и во время параллельных
изменений. Ниже команды групп; сверить существование test paths после cutover.

### 7.3. Focused проверки

```bash
node --test test/provider-config.test.js test/model-selection.test.js test/provider-contract.test.js
node --test test/transports.test.js test/coder-provider-registry.test.js test/model-runtime.test.js
node --test test/coder-crush.test.js test/coder-omp-adapter.test.js test/coder-opencode2.test.js
node --test test/config-commands.test.js test/wizard.test.js test/init.test.js
node --test test/mcp-handlers.test.js test/mcp-tools.test.js test/mcp-server-cancellation.test.js
node --test test/migration-transaction.test.js test/migration-0.41-fixtures.test.js
```

Новые regression files добавить в соответствующие группы, а удалённые obsolete
Crush-incomplete tests не запускать как обязательный старый контракт. Existing
best-effort suites выполнять с принятым в репозитории разделением через npm scripts.

### 7.4. Real command smoke

Команды запускать в подготовленном временном окружении с известной тестовой
конфигурацией. `TRISS_BIN` ниже указывает на implementation worktree; cwd процесса
должен быть временным project directory, не checkout с пользовательской работой.
Новые flags из плана проверяются после реализации, не на исходной версии.

```bash
TRISS_BIN=/Volumes/Orange/Projects/.worktrees/triss/wizard-full-setup-plan/bin/triss.js
node "$TRISS_BIN" config wizard --standard --local
node "$TRISS_BIN" config wizard --advanced --local
node "$TRISS_BIN" config wizard opencode-go --local
node "$TRISS_BIN" config wizard coder --local --coder-engine omp --coder-provider moonshot
node "$TRISS_BIN" config wizard --standard --local --yes --agent none
node "$TRISS_BIN" init --setup --target claude
node "$TRISS_BIN" status
node "$TRISS_BIN" migrate --json
```

Для model smoke подготовить маленький tracked `sample.txt` с известной строкой
`wizard-smoke-42`, затем небольшое tracked изменение этого файла для review diff.
Настроить fixture endpoint/credential и exact model transport, либо использовать
явно разрешённый live provider. Модель в примерах — существующий live smoke model,
а не новый default продукта. Каждый запуск имеет реальный native engine.

```bash
node "$TRISS_BIN" ask --paths sample.txt --question "What marker is in the file?" --engine opencode2 --provider opencode-go --model muse-spark-1.3-contributor
node "$TRISS_BIN" ask --paths sample.txt --question "What marker is in the file?" --engine omp --provider opencode-go --model muse-spark-1.3-contributor
node "$TRISS_BIN" ask --paths sample.txt --question "What marker is in the file?" --engine crush --provider opencode-go --model muse-spark-1.3-contributor
node "$TRISS_BIN" ask --paths sample.txt --question "What marker is in the file?" --engine direct --provider opencode-go --model muse-spark-1.3-contributor
git diff -- sample.txt | node "$TRISS_BIN" review --stdin --skip-issue --engine opencode2 --provider opencode-go --model muse-spark-1.3-contributor
git diff -- sample.txt | node "$TRISS_BIN" review --stdin --skip-issue --engine omp --provider opencode-go --model muse-spark-1.3-contributor
git diff -- sample.txt | node "$TRISS_BIN" review --stdin --skip-issue --engine crush --provider opencode-go --model muse-spark-1.3-contributor
```

Проверить marker в ask output и относящийся к fixture diff review, selected route
и warnings. Одного exit 0 недостаточно. Повторить direct с Zen и native routes с
Anthropic protocol; в A15 перебрать остальные provider/engine combinations.
Для coding smoke в disposable project попросить создать небольшой файл с
известным содержимым и проверить фактический diff; текст «файл создан» не доказательство.
Отдельно вызвать MCP ask/review/coder через существующий stdio harness, проверить
selected route и interruption. Для всех перечисленных model-backed commands
обеспечить contract coverage; live ask/review — представители разных model roles,
а не основание забыть chat/write/fetch/commit/integration paths.

Существующий `npm run test:live-opencode-projection` проверяет только V1 и содержит
assertions exact agent text. Он не доказывает новые engines. Обновить его только
в части actual behavior; не перепривязывать тест к новому тексту предупреждения.

### 7.5. Итоговая проверка

```bash
npm run check
npm run test:coverage
```

Если site files изменены, выполнить относящиеся к ним проверки из `site/package.json`
и реальную browser-проверку изменённых страниц; не угадывать имя site test script.
Не снижать thresholds и не пропускать реальные regressions ради зелёного статуса.

## 8. Формат работы и отчёта для coding-модели

1. Прочитать ADR и этот план до любых runtime edits. Не начинать с рефакторинга
   всего `coder.js` или новой TUI-библиотеки.
2. Проверить текущую ветку/worktree и пользовательские изменения. Не переносить
   личные `.env`, `.opencode`, `.triss`, screenshots, backups и сторонние файлы.
3. Выполнять пакеты P01–P12 в dependency order. После coherent verified части
   сохранять commit с DCO sign-off, чтобы работа не жила только в uncommitted
   worktree. Не удалять другие worktrees/branches и не включать чужой diff.
4. Для изменения exported symbols найти всех callers через доступный LSP.
   Не оставлять старую реализацию как fallback, если новый путь уже выбран.
5. После каждого пакета фиксировать: изменённые файлы, выполненные scenarios,
   фактический результат, remaining dependencies. Не писать «tests passed», если
   выполнены только formatter или mock-output tests.
6. Ошибка старого теста на запрещённый engine не повод вернуть запрет. Определить
   правильный user contract и заменить соответствующую regression проверку.
7. Если шаг упирается в внешний native contract, получить schema/help/source и
   выполнить минимальный native experiment. Отсутствие информации в старом Triss
   README не доказательство невозможности. Не изобретать успешный adapter.
8. Не добавлять retries, telemetry, exact version locks, новые permissions gates
   или дополнительные подтверждения «на всякий случай».
9. Изменять этот план при реализации только для честных status/evidence и явно
   согласованных изменений scope. Не вычёркивать acceptance, чтобы объявить done.

Финальный отчёт реализации содержит:

- Easy/Advanced/targeted поведение и screenshots/redacted terminal evidence;
- таблицу A01–A22: passed / failed / externally blocked с фактической причиной;
- tested native engine versions и transport/protocol coverage;
- выполненные команды и их результаты;
- объяснение best-effort limitations без заявлений о несуществующих гарантиях;
- реальные невыполненные live checks, если credentials недоступны;
- commit IDs и состояние PR/CI, только если эти действия поручены.

**Done означает: wizard удобен и полон, выбранные routes исполнимы, искусственные
блокировки сняты во всей цепочке, ограничения объяснены, пользовательские choices
сохранены, обязательная приёмка доказана. «UI готов, runtime потом» — не done.**
