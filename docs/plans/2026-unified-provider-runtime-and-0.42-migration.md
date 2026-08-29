# План: единый provider runtime и миграция конфигурации в Triss 0.42.0

## Статус решения

Этот документ фиксирует согласованный clean cutover для релиза `0.42.0`. Текущая версия перед cutover — `0.41.x`.

Цель: убрать архитектурное разделение между `worker` для direct inference и providers для coder. После cutover любая model-backed команда выбирает provider, model, engine и effort через один публичный контракт. Командный слой не знает provider IDs, credential names, endpoints или wire protocols.

Релиз намеренно несовместим с конфигурацией `<0.42.0`:

```bash
npm install -g triss-coworker@latest
triss migrate
triss status
```

`triss migrate` — единственное место в `0.42.0`, которое понимает legacy worker schema. Обычный runtime не содержит compatibility aliases, fallback readers или deprecated paths.

## Принятые решения

1. `worker` перестаёт быть отдельным режимом и становится canonical provider `openai-compatible`.
2. Canonical provider IDs:
   - `openai-compatible`;
   - `zai`;
   - `opencode-zen`;
   - `opencode-go`;
   - `moonshot`;
   - `kimi-for-coding`.
3. Legacy aliases удаляются: `worker`, `deepseek`, `glm`, `kimi`, `openai`, `triss-worker` и другие старые spellings не принимаются runtime.
4. Команды не имеют provider capability matrix. Provider/transport/engine layer обязан выполнить нормализованную задачу либо вернуть ошибку своего слоя.
5. Публичные presets `flash` и `pro` удаляются. Они не отражают реальную роль модели.
6. У каждого configured provider есть две конкретные роли:
   - `model` — основная модель;
   - `smallModel` — модель для лёгких задач.
7. Все model-backed команды принимают одинаковый набор model-selection options:
   - `--provider`;
   - `--model`;
   - `--engine`;
   - `--effort low|medium|high|xhigh|max`.
8. `--engine` имеет то же значение, что существующий coder option: execution engine. Параметр нигде не игнорируется.
9. Pricing и существующая cost semantics не меняются в рамках этого cutover.
10. После успешного `triss migrate` post-success config rollback не поддерживается. Binary downgrade не блокируется, но downgrade с `0.42.0+` на `<0.42.0` после migration объявляется unsupported.
11. Persisted engine sessions не мигрируются: legacy worker не владел отдельным session format.
12. Generic ask/review traffic считается обычным coding workload для всех providers; отдельная provider certification/capability gate не вводится.
13. Anthropic Messages transport реализуется через официальный `@anthropic-ai/sdk`.
14. Triss-owned agent rule blocks мигрируются автоматически; пользовательский текст вне markers не изменяется.
15. Legacy worker values удаляются из Triss-owned configs только после успешной записи и production-verification всех новых provider values. Команда не сообщает success, пока cleanup не завершён.

## Нецели

В этот релиз не входят:

- deprecation period;
- compatibility aliases;
- runtime fallback к `TRISS_WORKER_*`;
- автоматический post-success config rollback;
- блокировка `triss update --rollback`, npm downgrade или ручной подмены бинарника;
- рекурсивная модификация opaque engine session stores;
- изменение pricing tables или cost attribution;
- новый provider capability/certification subsystem;
- изменение пользовательского текста вне Triss-owned markers;
- попытка изменить parent shell, CI secrets или внешний secret manager из дочернего процесса.

## Архитектурные инварианты

### Командный слой provider-neutral

После cutover в command implementations не должно быть:

- canonical или legacy provider IDs;
- provider-specific environment names;
- provider endpoints;
- model prefixes;
- wire protocol names;
- `if (provider === ...)`;
- provider-specific reasoning, retry, usage или error branches.

Добавление нового provider требует только:

1. registry entry;
2. provider config schema;
3. transport adapter, если существующие transports недостаточны;
4. engine projection tests.

Оно не требует изменений в `ask.js`, `review.js`, `coder.js`, integration handlers или MCP schemas.

### Слои

```text
CLI / MCP / integrations
          │
          ▼
normalized task request
          │
          ▼
model selection resolver
          │
          ▼
resolved provider route
          │
          ├── direct transport engine
          ├── OpenCode engine
          ├── OpenCode 2 engine
          ├── OMP engine
          └── Crush engine
```

Command layer формирует задачу и ожидаемый output contract. Registry и resolver выбирают модель и route. Engine исполняет задачу. Transport отвечает за wire format.

### Одна canonical vocabulary

Canonical values используются в:

- CLI;
- MCP input/output schemas;
- config;
- status;
- usage records;
- engine projections;
- documentation;
- site;
- generated agent instructions.

Legacy vocabulary существует только внутри migration module и migration fixtures.

## Публичный model-selection contract

### Общие options

Все model-backed CLI commands принимают:

```text
--provider <canonical-provider-id>
--model <provider/model-id-or-bare-id>
--engine <engine-id>
--effort <low|medium|high|xhigh|max>
```

Допустимый короткий alias для effort:

```text
-e <level>
```

Не добавлять нестандартный long option с одним дефисом `-effort`.

MCP tools используют поля:

```json
{
  "provider": "zai",
  "model": "glm-5.2",
  "engine": "direct",
  "effort": "high"
}
```

CLI и MCP используют один parser/validator, а не параллельные enum lists.

### Effort

Допустимые значения строго:

```text
low
medium
high
xhigh
max
```

Правила:

- регистр нормализуется CLI parser либо отклоняется единообразно;
- неизвестное значение отклоняется до network request или child spawn;
- отсутствие option означает native default выбранного engine;
- command-specific hidden effort defaults не добавляются;
- explicit effort проходит через normalized request без provider checks в command;
- каждый engine adapter отображает пять logical levels в собственный protocol/config;
- engine не имеет права silently downgrade explicit effort;
- если upstream возвращает невозможность применить значение, adapter возвращает явную execution error.

### Model grammar

Public selector разбирается по первому `/`:

```text
provider/model-id
```

Всё после первого `/` сохраняется дословно. Это необходимо для nested native IDs:

```text
opencode-zen/vendor/family/model
openai-compatible/org/project/model
```

Bare model допустим только вместе с resolved provider:

```bash
triss ask --provider zai --model glm-5-turbo
```

Provider-qualified model сам задаёт provider:

```bash
triss ask --model zai/glm-5-turbo
```

Конфликт отклоняется:

```bash
triss ask --provider moonshot --model zai/glm-5-turbo
```

Нельзя молча предпочитать `--provider` или model prefix.

### Precedence

Единственный resolver применяет порядок:

1. определить task role: `smallModel` или `model`;
2. разобрать explicit `--model`, если он provider-qualified;
3. выбрать provider из model prefix, explicit `--provider` или configured default;
4. проверить конфликт explicit provider и model prefix;
5. выбрать explicit model либо provider role model;
6. выбрать explicit engine либо существующий command default;
7. выбрать explicit effort либо native engine default;
8. разрешить credential provenance и route;
9. вернуть immutable resolved request.

Ни CLI handler, ни MCP handler, ни integration handler не повторяет этот precedence.

## Model roles

### Small-model tasks

По умолчанию `smallModel` используют лёгкие чтение, поиск, summarization, classification и transformation paths:

- `ask`;
- `chat`;
- `fetch --question`;
- web content search/answer paths;
- `commit-msg`;
- GitHub summaries;
- GitLab summaries;
- Jira summaries;
- Linear summaries;
- Confluence summaries;
- другие integration summaries с тем же коротким text-output contract.

### Main-model tasks

По умолчанию `model` используют:

- `review`;
- `coder`;
- `write`.

### Overrides

Explicit `--model` всегда перекрывает role selection. Команда не преобразует explicit model в другую модель из-за task role.

Role selection — metadata task contract, а не публичный preset. CLI не принимает `--model flash` или `--model pro` как специальные значения.

## Providers и конфигурация

### Default provider

Новая схема имеет один явный default:

```env
TRISS_DEFAULT_PROVIDER=openai-compatible
```

Сейчас общего default provider нет: direct inference неявно использует worker, coder — встроенный Z.AI model. Cutover устраняет это расхождение.

### Provider profiles

Каждый provider profile содержит:

```js
{
  id,
  credential,
  model,
  smallModel,
  route,
  transport,
  policy,
  engineProjection,
}
```

Логическая config shape:

```text
providers.<id>.model
providers.<id>.smallModel
```

Flat env representation остаётся допустимым storage format, но config layer обязан преобразовывать его в structured immutable snapshot.

Рекомендуемые canonical env fields:

```text
TRISS_CONFIG_SCHEMA=2
TRISS_DEFAULT_PROVIDER

TRISS_OPENAI_COMPATIBLE_API_KEY
TRISS_OPENAI_COMPATIBLE_BASE_URL
TRISS_OPENAI_COMPATIBLE_MODEL
TRISS_OPENAI_COMPATIBLE_SMALL_MODEL

ZHIPU_API_KEY
TRISS_ZAI_MODEL
TRISS_ZAI_SMALL_MODEL

OPENCODE_API_KEY
TRISS_OPENCODE_ZEN_MODEL
TRISS_OPENCODE_ZEN_SMALL_MODEL
TRISS_OPENCODE_GO_MODEL
TRISS_OPENCODE_GO_SMALL_MODEL

MOONSHOT_API_KEY
TRISS_MOONSHOT_BASE_URL
TRISS_MOONSHOT_MODEL
TRISS_MOONSHOT_SMALL_MODEL

KIMI_API_KEY
TRISS_KIMI_FOR_CODING_MODEL
TRISS_KIMI_FOR_CODING_SMALL_MODEL
```

Credential names already owned by upstream providers remain unchanged unless explicitly listed as migrated. Provider role fields replace coder-specific global pins.

### Provider IDs

Registry contains exactly:

| Provider | Credential source | Transport family |
| --- | --- | --- |
| `openai-compatible` | `TRISS_OPENAI_COMPATIBLE_API_KEY` | OpenAI Chat compatible, configurable endpoint |
| `zai` | `ZHIPU_API_KEY` | provider policy chooses verified OpenAI-compatible route |
| `opencode-zen` | `OPENCODE_API_KEY` | registry/engine projection |
| `opencode-go` | `OPENCODE_API_KEY` | registry/engine projection |
| `moonshot` | `MOONSHOT_API_KEY` | OpenAI-compatible Moonshot route |
| `kimi-for-coding` | `KIMI_API_KEY` | Anthropic Messages |

Registry не содержит public aliases.

### OpenAI-compatible provider

`openai-compatible` — обычный configurable provider, не special worker mode.

Profile владеет:

- API key;
- base URL;
- exact main model;
- exact small model;
- endpoint provenance;
- OpenAI-compatible transport options;
- usage/error normalization hooks.

Default endpoint может сохранить текущий DeepSeek-compatible behavior, но command layer этого не знает.

### Volatile OpenCode catalogues

Zen/Go setup может получать live catalogue для выбора initial `model` и `smallModel`. Выбранные exact IDs сохраняются в provider profile.

Runtime не должен менять модель между вызовами из-за изменения remote catalogue. Live catalogue используется setup/config flow, а не как скрытый per-request preset resolver.

## Provider registry

Создать общий registry вместо раздельных direct/coder registries.

Целевой API:

```js
getProviderDefinition(id)
listProviderDefinitions()
resolveProviderProfile(snapshot, id)
resolveModelSelection(request, snapshot)
resolveProviderRoute(selection, snapshot)
```

`resolveProviderRoute` возвращает immutable object:

```js
{
  providerId,
  publicModel,
  nativeModel,
  credential,
  endpoint,
  transport,
  policy,
  billingIdentity,
  provenance,
}
```

Требования:

- credential value не сериализуется в logs/envelopes/status;
- public model остаётся provider-qualified;
- native model сохраняет nested model ID;
- route содержит source scope для каждого sensitive field;
- registry metadata генерирует provider lists для CLI help, MCP schemas, status и wizard;
- command modules не импортируют concrete provider definitions.

Удалить или заменить:

- `src/models.js` как отдельный direct provider resolver;
- `CODER_PROVIDER_REGISTRY` как самостоятельный source of truth;
- provider aliases в `src/coder-models.js`;
- повторную dispatch logic в `src/client.js`;
- worker-specific route construction в `src/commands/coder.js`.

## Config snapshots и provenance

Config resolver формирует snapshot из:

1. explicit CLI/MCP options;
2. parent process environment;
3. project-local Triss env;
4. global Triss env;
5. registry defaults.

Для каждого значения snapshot хранит:

```js
{
  value,
  source,
  scope,
  path,
}
```

Merge precedence не должен уничтожать provenance. Migration работает с physical stores по отдельности, а не с effective merged snapshot.

Generic snapshot обязан различать:

- значение отсутствует;
- значение присутствует пустым;
- значение пришло из shell;
- значение пришло из project config;
- значение пришло из global config;
- значение является registry default.

Provider selection и engine projections получают уже разрешённый snapshot.

## Transports

### Общий transport contract

Каждый transport принимает normalized request:

```js
{
  route,
  messages,
  effort,
  maxOutputTokens,
  signal,
  timeout,
  outputContract,
}
```

И возвращает normalized result:

```js
{
  text,
  reasoning,
  finishReason,
  usage,
  rawMetadata,
}
```

Transport не знает CLI command names.

### OpenAI Chat

Вынести существующую OpenAI-compatible request construction из `src/client.js` в bounded transport adapter.

Adapter владеет:

- URL construction;
- auth header;
- messages;
- streaming/buffered parsing;
- cancellation;
- timeout;
- provider policy hooks;
- error classification;
- normalized usage.

### OpenAI Responses

Добавить отдельный adapter, не имитировать Responses через Chat fields.

Он возвращает тот же normalized result и поддерживает полный logical effort contract через route policy.

### Anthropic Messages

Использовать официальный `@anthropic-ai/sdk`.

Изменение dependency требует:

- обновления `package.json` и lockfile;
- license review;
- обновления `THIRD_PARTY_NOTICES`;
- проверки поддерживаемой Node version;
- явного timeout/cancellation ownership;
- запрета SDK-owned retries, если они конфликтуют с Triss retry policy.

### Provider policy hooks

Provider-specific особенности живут в provider/transport layer:

- endpoint discovery/fallback;
- thinking/reasoning mapping;
- request headers;
- error diagnostics;
- retry classification;
- usage normalization;
- billing identity.

Commands задают только logical effort и task payload.

## Унифицированный execution runtime

Создать один entry point для model-backed tasks:

```js
executeModelTask({
  task,
  input,
  provider,
  model,
  engine,
  effort,
  signal,
  timeout,
})
```

Он выполняет:

1. task-role selection;
2. common option validation;
3. config snapshot;
4. provider/model resolution;
5. engine resolution;
6. engine projection;
7. execution;
8. normalized usage recording;
9. normalized output/error.

### Engines

Engine означает execution runtime во всех командах.

- `direct` выполняет normalized request через transport adapter;
- `opencode`, `opencode2`, `omp`, `crush` получают resolved provider route через projection adapter;
- explicit engine option не игнорируется;
- существующий coder engine meaning не переименовывается и не раздваивается;
- отсутствие engine сохраняет существующий safe default конкретной command family;
- любой explicit effort передаётся выбранному engine.

Engine projection не перечитывает provider env names и не разбирает public aliases.

### Coder projection

Coder передаёт engine adapter:

```js
{
  route,
  mainModel: profile.model,
  smallModel: profile.smallModel,
  effort,
  task,
}
```

Engine-specific configuration генерируется из route. Provider selection не повторяется внутри `src/commands/coder.js`.

Если engine требует main/small models из одного credential scope, это проверяет engine projection после resolution. Command не содержит provider-specific исключений.

## Миграция direct model callers

Перевести на execution runtime:

- `src/commands/ask.js`;
- `src/commands/review.js`;
- `src/commands/chat.js`;
- `src/commands/write.js`;
- `src/commands/fetch.js` для `--question` и web-answer paths;
- `src/commands/commit-msg.js`;
- `src/integrations/_contract.js`;
- GitHub, GitLab, Jira, Linear и Confluence summary paths;
- `src/review-live.js`;
- MCP handlers для перечисленных операций.

Для каждого caller удалить:

- собственный provider normalization;
- собственный model default;
- provider-specific client construction;
- provider-specific token budget;
- локальные aliases;
- повторную usage normalization.

## CLI и MCP

### CLI

В `bin/triss.js`:

- добавить top-level `triss migrate`;
- добавить common model options ко всем model-backed commands;
- удалить legacy provider values из help;
- удалить worker-specific commands/options;
- удалить `flash`/`pro` wording;
- генерировать provider и effort validation из shared metadata;
- показывать canonical provider/model в diagnostics.

### MCP

В `src/mcp/tools.js` и handlers:

- одинаковые optional `provider`, `model`, `engine`, `effort`;
- canonical provider descriptions;
- no legacy enums;
- common schema fragments генерируются из shared contract;
- output envelopes используют canonical provider/model;
- restart MCP host обязателен после package update и migration.

Долго живущий MCP process не обязан hot-swap code/schema. Документация и update output требуют restart.

### Status

`triss status` показывает:

- config schema version;
- default provider;
- каждый configured provider;
- main model;
- small model;
- credential configured/missing без secret value;
- endpoint provenance без credential leakage;
- default/available engines;
- migration-required или cleanup-incomplete state;
- downgrade warning для migrated schema.

Status не читает legacy fields. Migration status reader может передать только sanitized migration state.

### Wizard

Wizard конфигурирует provider profiles, а не command-specific providers.

Flow:

1. выбрать canonical provider;
2. настроить credential/endpoint;
3. выбрать exact main model;
4. выбрать exact small model;
5. при необходимости проверить engine projection;
6. выбрать default provider;
7. записать config transactionally;
8. проверить production resolver.

## `triss migrate`

### Scope

Top-level command мигрирует:

- global Triss config;
- current project Triss config;
- Triss-owned OpenCode/OMP/Crush configuration layers;
- provider/model pins;
- Triss-owned managed blocks в project/global `CLAUDE.md` и `AGENTS.md`;
- Triss-owned structured usage records, где canonical provider/model являются частью active schema;
- другие persisted files, найденные обязательным legacy inventory.

Project-local migration запускается отдельно в каждом проекте с `.triss.env` или Triss-managed agent block. Команда не сканирует весь домашний каталог в поисках произвольных проектов.

### Legacy inventory

Перед реализацией зафиксировать все persisted spellings:

```text
TRISS_WORKER_API_KEY
TRISS_WORKER_BASE_URL
TRISS_WORKER_FLASH_MODEL
TRISS_WORKER_PRO_MODEL
TRISS_CODER_MODEL
TRISS_CODER_SMALL_MODEL
TRISS_KIMI_BASE_URL
worker
deepseek
glm
kimi
openai
openai-compatible как старый alias
triss-worker/
provider["triss-worker"]
```

`openai-compatible` является canonical target и поэтому не удаляется, когда уже используется в новой schema. Migration различает old alias context и canonical new context структурно, не глобальной string replacement.

### Field mapping

Основное соответствие:

| Legacy | Canonical target |
| --- | --- |
| `TRISS_WORKER_API_KEY` | `TRISS_OPENAI_COMPATIBLE_API_KEY` |
| `TRISS_WORKER_BASE_URL` | `TRISS_OPENAI_COMPATIBLE_BASE_URL` |
| `TRISS_WORKER_PRO_MODEL` | `TRISS_OPENAI_COMPATIBLE_MODEL` |
| `TRISS_WORKER_FLASH_MODEL` | `TRISS_OPENAI_COMPATIBLE_SMALL_MODEL` |
| `triss-worker/<id>` | `openai-compatible/<id>` |
| `TRISS_KIMI_BASE_URL` | `TRISS_MOONSHOT_BASE_URL` |
| coder main pin | `providers.<resolved-id>.model` |
| coder small pin | `providers.<resolved-id>.smallModel` |
| implicit worker direct default | `TRISS_DEFAULT_PROVIDER=openai-compatible` |

Legacy coder pins могут указывать не на worker. Их provider prefix определяет профиль, в который записываются `model` и `smallModel`.

### Default-provider migration

Если новая explicit default отсутствует:

1. существует legacy worker profile — выбрать `openai-compatible`, сохраняя прежний direct default;
2. worker отсутствует, существует explicit coder main model — выбрать provider его canonical prefix;
3. иначе настроен ровно один однозначный provider — выбрать его;
4. один `OPENCODE_API_KEY` без выбранного Zen/Go profile не считается однозначным;
5. несколько возможных providers — не угадывать, вернуть точную remediation для `TRISS_DEFAULT_PROVIDER`;
6. credentials отсутствуют — config format можно мигрировать, но `status` сообщает setup requirement.

Если worker и coder использовали разные providers, мигрируются оба provider profiles. Default остаётся `openai-compatible`; coder продолжает иметь exact profile, доступный через explicit/default reconfiguration.

### Conflict rules

Для каждого physical store:

- old absent, new absent — no-op;
- old present, new absent — copy old to new;
- old/new semantically equal — keep new and schedule old cleanup;
- old/new differ — conflict, не перезаписывать;
- malformed structured target — fail before mutation;
- unknown provider/model selector — fail with sanitized location;
- user-edited managed block with malformed markers — fail that transaction before mutation.

Conflict report показывает paths и field names, но не values credentials.

### Parent shell и внешние secret stores

Child process не может изменить parent environment.

Если legacy values существуют только в shell:

- не записывать secret в file автоматически;
- показать exact rename instructions без значения;
- вернуть incomplete migration state;
- отдельно документировать shell profile, GitHub Actions, CI secret store и secret-manager updates.

Triss-owned `.env` stores мигрируются автоматически.

## Migration transaction

### State machine

```text
not_started
    │
    ▼
preflight_complete
    │
    ▼
canonical_staged
    │
    ▼
canonical_committed
    │
    ▼
canonical_verified
    │
    ▼
legacy_cleanup_staged
    │
    ▼
legacy_cleanup_committed
    │
    ▼
complete
```

### Preflight

До первой записи:

1. определить source и target schema versions;
2. обнаружить все physical targets;
3. проверить ownership/symlink policy;
4. прочитать каждый target bounded reader;
5. разобрать structured formats;
6. вычислить canonical target values;
7. обнаружить conflicts;
8. проверить resource limits;
9. проверить свободное место;
10. сформировать redacted plan;
11. получить locks/CAS expectations.

Любая preflight error оставляет все файлы byte-identical.

### Phase A: canonical data migration

1. Создать private transaction directory `0700`.
2. Сохранить original bytes с mode `0600`.
3. Сформировать новые canonical values, пока сохраняя legacy fields в target files.
4. Записать sibling temp files.
5. Fsync files и directories там, где platform поддерживает.
6. Проверить CAS/hash исходных targets.
7. Atomic rename всех canonical-stage targets по transaction protocol.
8. Перечитать их через production config parser.
9. Разрешить default provider, main/small models и engine projections production resolver.
10. Проверить, что credential bytes не попали в report/log.

До завершения этого barrier legacy values не удаляются ни из одного Triss-owned config.

### Phase B: post-migration legacy cleanup

Cleanup начинается только после `canonical_verified`.

Он удаляет из всех Triss-owned migrated configs:

- `TRISS_WORKER_*` fields и их values;
- legacy `TRISS_CODER_MODEL` и `TRISS_CODER_SMALL_MODEL` после переноса в provider profiles;
- `TRISS_KIMI_BASE_URL` после переноса;
- legacy worker provider entries;
- `triss-worker/*` model selectors;
- legacy aliases в Triss-owned structured config;
- старые worker instructions в managed agent blocks.

Правила:

1. cleanup использует structured editors, не global text replacement;
2. cleanup повторно проверяет CAS после canonical verification;
3. cleanup не удаляет parent-shell/CI values, которыми процесс не владеет;
4. cleanup не изменяет пользовательский текст вне managed markers;
5. cleanup не удаляет canonical `openai-compatible` data;
6. cleanup stage получает собственные temp files и atomic rename;
7. после commit каждый target перечитывается и проверяется на отсутствие legacy fields;
8. repository-wide runtime readers уже не понимают legacy data;
9. команда печатает success только после cleanup verification.

Если Phase B не завершилась:

- canonical values остаются сохранёнными;
- legacy values остаются только там, где cleanup не был подтверждён;
- migration возвращает non-zero `cleanup incomplete`;
- повторный запуск продолжает cleanup идемпотентно;
- нельзя объявлять migration complete;
- секреты не теряются.

Это обеспечивает требование: worker values удаляются только после окончания переноса данных, но до окончательного success команды.

### Failure rollback внутри команды

До `canonical_verified` migration пытается восстановить original bytes всех уже изменённых targets.

При успешном rollback:

- temporary/backup data с credentials удаляется;
- команда возвращает исходную migration error;
- targets соответствуют исходному состоянию.

При rollback failure:

- private backup сохраняется;
- output показывает migration ID, sanitized path и manual recovery instructions;
- backup contents никогда не печатаются;
- дальнейшая mutation прекращается.

После `complete` config rollback не поддерживается.

### Backup lifecycle

Credential-bearing backup/staging:

- удаляется после полного success;
- удаляется после failure с успешным rollback;
- сохраняется только при rollback failure;
- permissions `0700` для directory и `0600` для files;
- не индексируется usage/report commands;
- не отправляется telemetry;
- cleanup path проверяет ownership и symlinks.

### Resource bounds

Hard limits:

```text
maxTargets = 64
maxStructuredTargetBytes = 16 MiB
maxUsageBytes = 256 MiB
maxJsonlLineBytes = 1 MiB
maxTotalStagedBytes = 512 MiB
```

Usage JSONL преобразуется streaming parser/writer, не целиком в памяти.

Free-space preflight учитывает:

- original backups;
- canonical staging;
- cleanup staging;
- rollback margin.

На Windows migration явно предупреждает, что POSIX mode guarantees недоступны, и использует существующую platform ownership policy. Нельзя ложно утверждать эквивалентность `0600`.

### Idempotency

Повторный запуск:

- complete schema без legacy fields → `already migrated`, exit `0`;
- canonical data есть, cleanup не завершён → продолжить Phase B;
- equal old/new values → удалить old после verification;
- конфликт old/new → fail без mutation;
- transaction debris без rollback failure marker → scrub after ownership validation;
- rollback-failure backup → требовать явного recovery, не перезаписывать его.

## Managed agent rules

Migration обновляет только Triss-owned marker blocks через существующие abstractions:

- `src/agent-rules.js`;
- `src/marker-transaction.js`;
- marker constants/transaction flow из `src/commands/init.js`.

Targets:

- project `CLAUDE.md`;
- project `AGENTS.md`;
- global Claude rule file;
- global Codex rule file.

Требования:

- bytes вне managed block остаются неизменными;
- malformed/duplicate markers блокируют target;
- CAS предотвращает overwrite concurrent user edit;
- новый block генерируется из актуального template, а не ad-hoc replacements;
- project migration запускается в каждом проекте отдельно;
- при невозможности обновления output показывает exact `triss init --target ... --force` remediation;
- cleanup verification не находит worker commands/options внутри managed block.

## Usage и pricing

Usage records после cutover используют canonical provider и public provider-qualified model.

`recordUsage` получает resolved route и normalized engine result. Command не вычисляет provider/model повторно.

Согласованное ограничение: pricing algorithm и текущие pricing tables не меняются. В частности:

- не вводить новый billing tuple только ради provider unification;
- не пересчитывать historical cost;
- migration сохраняет записанную стоимость;
- существующая model-based cost behavior остаётся текущим контрактом;
- изменение pricing требует отдельного плана.

Usage migration меняет только поля, необходимые активной schema, и не интерпретирует стоимость заново.

## Persisted sessions и opaque state

Не сканировать и не переписывать opaque engine session stores, run state или result payloads для поиска worker strings.

Причина: legacy worker не владел отдельными session records; рекурсивная string replacement в engine state опаснее, чем отсутствие миграции.

Triss-owned structured records мигрируются только если active reader требует canonical provider/model. Opaque engine data остаётся вне scope.

## Update и downgrade policy

### Upgrade notice

При пересечении `<0.42.0 → >=0.42.0`:

```text
Triss 0.42 uses the unified provider configuration.
Before running model commands:
  triss migrate
  triss status
Then restart MCP hosts and agent sessions.
```

Notice появляется:

- в `triss update` check/apply output;
- после успешного standalone apply;
- в npm/manual upgrade guide;
- на сайте;
- в release notes;
- в missing-provider troubleshooting.

### Downgrade

После успешного `triss migrate`:

```text
Do not downgrade Triss from 0.42.0+ to a version below 0.42.0.
Older runtimes cannot read the unified provider configuration.
```

Политика:

- не блокировать `triss update --rollback`;
- не блокировать npm downgrade;
- не реализовывать post-success config restore;
- печатать non-blocking warning, если известный rollback target `<0.42.0`;
- документировать unsupported mixed-version access к одному config store;
- требовать restart MCP host и agent sessions после update/migration.

## Документация, templates и сайт

Обновить:

- `README.md`;
- `CHANGELOG.md`;
- `.env.example`;
- `ARCHITECTURE.md`;
- config reference;
- CLI reference;
- MCP reference;
- provider/coder docs;
- usage docs, не меняя pricing semantics;
- troubleshooting;
- release guide;
- `templates/claude.md`;
- `templates/claude-full.md`;
- `templates/codex.md`;
- `templates/codex-full.md`;
- website docs/content;
- site release/upgrade notice;
- generated config defaults;
- standalone bootstrap/help text.

Обязательный upgrade block:

> **Upgrading from Triss < 0.42.0**
>
> Triss 0.42 replaces worker configuration and model presets with unified provider profiles. After installing the update and before running model commands:
>
> ```bash
> triss migrate
> triss status
> ```
>
> Restart MCP hosts and agent sessions. After a successful migration, do not downgrade to a Triss version below 0.42.0.

Документация не предлагает legacy aliases как временный workaround.

## Файловый план реализации

### Foundation

Создать/перестроить shared modules для:

- provider registry;
- provider profile schema;
- common model selector/parser;
- common request resolver;
- transport registry;
- engine execution contract;
- effort enum/mapping;
- config snapshot/provenance.

Ожидаемые затронутые существующие modules:

- `src/models.js`;
- `src/client.js`;
- `src/coder-providers.js`;
- `src/coder-models.js`;
- `src/config.js`;
- `src/config-defaults.js`;
- `src/provider-errors.js`;
- `src/usage.js`;
- `src/usage-schema.js`.

### Direct commands и integrations

Перевести callers по одному shared contract, не добавляя command-local adapters:

- `src/commands/ask.js`;
- `src/commands/review.js`;
- `src/commands/chat.js`;
- `src/commands/write.js`;
- `src/commands/fetch.js`;
- `src/commands/commit-msg.js`;
- `src/review-live.js`;
- integration contract/clients.

### Coder engines

Перевести:

- `src/commands/coder.js`;
- `src/coder-providers.js`;
- `src/coder-models.js`;
- `src/coder-engines/*`;
- OpenCode config generation;
- OMP runtime model projection;
- Crush configuration/proxy route.

Сохранить security boundaries:

- only selected provider credential reaches child/proxy;
- endpoint provenance checks;
- deny-first protected mode;
- exact model/provider binding;
- no broad child environment inheritance;
- no credential values in envelope.

### CLI/MCP/status/wizard

Обновить:

- `bin/triss.js`;
- `src/mcp/tools.js`;
- MCP handlers/server;
- `src/commands/status.js`;
- `src/commands/config.js`;
- wizard flows;
- `src/commands/exec.js`, если route options проходят через exec.

### Migration

Добавить bounded migration modules и top-level command. Разделить:

- inventory/discovery;
- parsers/codecs;
- semantic mapping;
- conflict detection;
- transaction coordinator;
- canonical verification;
- legacy cleanup;
- managed-block migration;
- redacted reporting.

Migration code — единственный production namespace, где допустимы legacy literals.

## Тестовая стратегия

### Resolver contract

Проверить:

- default provider;
- explicit provider;
- provider-qualified model;
- bare model с provider;
- nested model ID;
- conflicting provider/model;
- main/small task-role mapping;
- explicit model override;
- unknown provider;
- missing role model;
- config scope precedence;
- provenance preservation.

### Command parity

Для каждой model-backed command family:

- одинаковые `provider/model/engine/effort` inputs;
- отсутствующий option использует shared resolver;
- explicit model не заменяется role default;
- no provider-specific error handling in command;
- CLI и MCP получают одинаковый resolved request;
- small-task matrix и main-task matrix соответствуют этому плану.

### Effort

Для каждого engine:

- `low`;
- `medium`;
- `high`;
- `xhigh`;
- `max`;
- omitted/native default;
- invalid value rejected before execution;
- explicit value not silently ignored/downgraded.

Проверить CLI `--effort`/`-e` и MCP schema parity.

### Transports

Для OpenAI Chat, Responses и Anthropic Messages:

- buffered response;
- streaming response;
- cancellation;
- timeout;
- auth failure;
- 404;
- 429;
- malformed body;
- usage normalization;
- finish reason;
- logical effort mapping;
- secret-free diagnostics.

Live smoke использует opt-in credentials и не является отдельным provider certification gate.

### Engine projections

Для OpenCode, OpenCode2, OMP и Crush:

- canonical provider/model projection;
- main/small exact IDs;
- effort mapping;
- credential selection;
- nested model IDs;
- endpoint provenance;
- protected/raw credential modes;
- envelope canonical fields;
- no legacy aliases.

### Migration fixtures

Fixtures должны происходить из реально генерируемых `0.41.x` formats, а не только hand-written examples.

Сценарии:

1. worker-only global config;
2. worker-only project config;
3. worker plus Z.AI coder pins;
4. GLM/Z.AI-only user;
5. Moonshot-only user;
6. OpenCode key с ambiguous Zen/Go selection;
7. multiple configured providers;
8. equal old/new values;
9. conflicting old/new credentials;
10. conflicting old/new model roles;
11. `triss-worker/<id>` nested model;
12. old Kimi base URL;
13. managed Claude block;
14. managed Codex block;
15. user text surrounding managed block;
16. malformed markers;
17. shell-only legacy values;
18. CI/external secret remediation;
19. usage JSONL near limits;
20. oversized line;
21. too many targets;
22. insufficient free space;
23. interrupted canonical commit;
24. canonical verification failure;
25. cleanup commit failure;
26. rerun from cleanup-incomplete;
27. rollback success;
28. rollback failure with retained backup;
29. fully migrated rerun;
30. clean 0.42 install with no migration.

### Post-migration cleanup tests

Отдельно доказать:

- old fields присутствуют во время canonical verification;
- cleanup не начинается до production resolver success;
- после success legacy worker values отсутствуют во всех owned configs;
- cleanup failure не удаляет canonical values;
- rerun завершает cleanup;
- user text вне markers byte-identical;
- shell/CI legacy values только диагностируются;
- command не печатает success при cleanup-incomplete;
- secrets отсутствуют в stdout/stderr/report/path.

### Update/docs tests

Проверить:

- notice при crossing `<0.42.0 → >=0.42.0`;
- `triss migrate`, `triss status`, restart instructions;
- non-blocking downgrade warning;
- отсутствие ложного обещания config rollback;
- README/site/release wording consistent;
- generated defaults current;
- Markdown links valid.

## Security review gates

До merge проверить:

- credential values не попадают в CLI/MCP/errors/usage;
- migration backups private и bounded;
- symlinks и foreign-owned targets fail closed;
- CAS защищает concurrent edits;
- cleanup удаляет только structurally-owned legacy fields;
- managed blocks не затрагивают user text;
- provider routes не расширяют child credential set;
- official Anthropic SDK dependency/license отражены;
- no runtime legacy readers outside migration;
- no unbounded JSON/JSONL reads;
- rollback failure сохраняет достаточно данных для manual recovery без их печати.

## Implementation phases

### Phase 1 — contracts и characterization

1. Зафиксировать current behavior tests для direct defaults, coder defaults, config scopes и engine projections.
2. Добавить shared provider/model/effort schemas.
3. Зафиксировать полный legacy inventory.
4. Зафиксировать 0.41 migration fixtures.

### Phase 2 — registry, resolver и transports

1. Реализовать provider profiles и immutable snapshots.
2. Реализовать model selection precedence.
3. Реализовать main/small roles.
4. Выделить OpenAI Chat transport.
5. Добавить Responses transport.
6. Добавить Anthropic Messages transport через official SDK.
7. Реализовать normalized execution result.

### Phase 3 — commands и integrations

1. Перевести ask/chat/fetch/commit/integrations на small role.
2. Перевести review/write на main role.
3. Добавить common options и effort.
4. Удалить direct provider dispatch и presets.
5. Проверить CLI/MCP parity.

### Phase 4 — coder engines

1. Перевести coder на shared resolver и main/small provider profile.
2. Перевести каждый engine projection.
3. Удалить coder provider aliases и worker special cases.
4. Сохранить credential security gates.

### Phase 5 — migration

1. Реализовать discovery/preflight/conflicts.
2. Реализовать canonical Phase A.
3. Реализовать production verification barrier.
4. Реализовать post-success legacy cleanup Phase B.
5. Реализовать managed rule migration.
6. Реализовать idempotent resume cleanup.
7. Реализовать rollback-on-failure и backup lifecycle.
8. Добавить top-level CLI/status integration.

### Phase 6 — clean cutover

1. Удалить legacy CLI/API/MCP surface.
2. Удалить runtime legacy readers.
3. Удалить `flash`/`pro` concepts.
4. Удалить coder-specific global model pins после migration support.
5. Обновить docs/templates/site/update notices.
6. Обновить package version и release metadata в release change, не в ранних implementation commits.

### Phase 7 — verification и release gates

1. Focused resolver/transport/command tests.
2. Engine projection tests.
3. Full migration matrix.
4. Security tests.
5. Docs/site checks.
6. Full project test suite.
7. Opt-in live smoke для configured providers/engines.
8. Cleanup searches по legacy vocabulary вне migration fixtures/module.

## Cleanup search gates

Перед merge searches должны доказать отсутствие production references вне migration namespace:

```text
TRISS_WORKER_
triss-worker/
--provider worker
provider === 'worker'
provider == 'worker'
resolveProvider(input || 'worker')
flash
pro
TRISS_CODER_MODEL
TRISS_CODER_SMALL_MODEL
TRISS_KIMI_BASE_URL
```

`flash`/`pro` проверяются context-aware, потому что слова могут встречаться в unrelated prose/model IDs. Допустимые legacy occurrences:

- migration mapping implementation;
- migration fixtures/tests;
- historical changelog/upgrade documentation, где они явно помечены как legacy.

## Definition of done

Релиз готов, когда одновременно выполнено:

1. Все model-backed commands принимают общий `provider/model/engine/effort` contract.
2. Small-task и main-task mapping соответствует этому документу.
3. `flash`/`pro` отсутствуют как runtime concepts.
4. Один registry/resolver обслуживает direct и coder paths.
5. Command modules не содержат provider-specific details.
6. Каждый canonical provider имеет configured main/small model roles.
7. Все engines поддерживают пять effort levels без silent ignore.
8. `triss migrate` переносит global/project/provider/managed-rule data.
9. Legacy worker values удаляются только после canonical commit и production verification.
10. После migration success ни один Triss-owned config не содержит legacy worker values.
11. Cleanup failure безопасно возобновляется и не теряет canonical data.
12. Runtime не читает legacy fields и не принимает aliases.
13. Shell/CI limitations имеют exact remediation.
14. Backups bounded, private и удаляются по lifecycle policy.
15. Upgrade и downgrade warnings присутствуют в CLI/docs/site/release notes.
16. MCP hosts и agent sessions требуется перезапустить.
17. Pricing behavior остаётся неизменным.
18. Persisted engine sessions не переписываются.
19. Focused, migration, security, docs и full-suite checks проходят.
20. Clean install `0.42.0` работает без migration; upgrade с `<0.42.0` работает после `triss migrate`.
