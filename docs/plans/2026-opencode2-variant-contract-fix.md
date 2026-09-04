# План: исправление variant-контракта OpenCode 2

## Статус решения

Документ описывает исправление регрессии Triss `0.42.0`. До принятия плана
production-код не меняется.

Цель: снова признать опубликованный `@opencode-ai/cli@beta` совместимым и
передавать explicit reasoning effort через реальный CLI-контракт OpenCode 2,
не ослабляя version, capability, executable, configuration, credential и
resident-service проверки.

План прошёл независимый CLI-contract review, security review, test review и
дополнительный adversarial review через `/ar`. Замечания включены ниже:
capability check привязан только к реальным required option declarations;
help prose не используется как behavioral proof. Добавлены engine-boundary
validation, normalized-effort forwarding, orchestration/status tests и
loopback qualification реального beta; model-specific variant availability
больше не представлена как универсальная поддержка пяти значений.

## Проблема и подтверждённые факты

На `@opencode-ai/cli@beta` dist-tag опубликован `0.0.0-beta-19059`. Локально
проверены:

```text
triss 0.42.0
opencode2 v0.0.0-beta-19059
```

Реальный `opencode2 run --help` этой версии содержит:

```text
--standalone
--format
--auto
--model, -m string  Model to use in the format provider/model#variant
```

Отдельного `--variant` у beta-19059 нет.

Регрессия находится в `src/coder-engines/opencode2.js`:

1. `REQUIRED_CAPABILITIES` ошибочно требует `--variant`;
2. `buildOpenCode2RunArgv()` ошибочно формирует `--variant <effort>`;
3. синтетические help fixtures сами добавили несуществующий flag и поэтому не
   поймали расхождение с опубликованным CLI.

Из-за пункта 1 `triss status` правильно исполняет fail-closed ветку для
заданного Triss контракта, но сам контракт неверен:

```text
opencode2 0.0.0-beta-19059 (incompatible CLI; missing --variant)
```

`docs/opencode2-engine-plan.md` фиксирует ту же `provider/model#variant`
грамматику для старого `next-17430`. Это только историческое подтверждение:
authoritative evidence для исправления — verbatim help beta-19059 и
квалификация фактического binary.

Upstream beta source для опубликованной линии дополнительно устанавливает:

- `ModelResolver.withVariant()` возвращает `VariantUnavailableError`, если
  выбранного variant нет в catalog model;
- built-in variant generator для synthetic
  `@ai-sdk/openai-compatible`/GLM-5.2 создаёт только `high` и `max`;
- следовательно, наличие `#variant` в CLI grammar не доказывает, что любой
  model поддерживает все пять logical effort levels.

## Решения

### 1. Capability contract

Capability probe требует отдельные option declarations: `--standalone`,
`--format`, `--auto`, `--model`.

Поддержка `provider/model#variant` квалифицирована поведением текущего floor
`0.0.0-beta-19059`. Все более новые parseable версии принимаются по умолчанию;
точная фраза в help, spelling metavar и examples не являются compatibility
gate. Это исключает ложные отказы после безопасной правки upstream help.

Парсер проверяет whole option tokens внутри `FLAGS`/`GLOBAL FLAGS`, а не
произвольные substrings. `--model-old` не удовлетворяет `--model`;
option-like text вне этих sections не создаёт required records. Внутри section
каждая option-shaped строка считается declaration, все long aliases
учитываются, а indentation игнорируется. Поэтому вложенная option-shaped prose
неотличима от declaration и может квалифицировать option; это осознанный
forward-compatibility tradeoff для help локально установленного binary.
Регистр heading, необязательное двоеточие, ANSI styling и неодинаковый отступ
option records считаются presentation details.

`--variant` удаляется из списка обязательных flags. Missing list содержит
только реально отсутствующие required options.

`triss status` использует существующий renderer. Совместимость status означает
совместимость executable/required CLI surface; она не обещает, что каждая
конкретная пара model/effort существует в upstream model catalog.

### 2. Runtime argv

`buildOpenCode2RunArgv({ model, effort })` формирует один selector:

```text
effort отсутствует: --model provider/model
effort=high:       --model provider/model#high
```

Отдельный `--variant` никогда не передаётся. Positional prompt остаётся
последним аргументом; порядок `--agent`, `--session`, `--continue` и текущая
mutual-exclusion проверка не меняются.

Adapter получает normalized `selectedModel.effort`, а не исходный
`opts.effort`. Это сохраняет общий parser contract: например, допустимый
programmatic input `" HIGH "` превращается ровно в `#high`.

### 3. Base-model boundary

`#variant` — только engine-private runtime syntax. До credential selection,
isolation/worktree creation, proxy startup, session reservation и spawn
OpenCode 2 отклоняет resolved main model, уже содержащий `#`.

Проверка ставится в `runCoderRun()` сразу после получения
`selectedModel.publicModel` и применяется только при `engine ===
"opencode2"`. Она одинаково покрывает explicit и configured main model.
Сообщение указывает передавать variant через `effort`, а не внутри `model`.

Глобальный `parseModelSelector()` не меняется: запрет не распространяется
автоматически на direct, OpenCode 1, OMP и Crush, пока их собственный контракт
этого не требует.

Variant suffix применяется только к argv selector. Без suffix остаются:

- canonical public model;
- provider route и billing identity;
- transient overlay `model` и model keys;
- credential-proxy `model`/`models` pins;
- requested, engine, usage и persisted model identities.

### 4. Model-specific effort semantics

Public vocabulary остаётся общей:

```text
low | medium | high | xhigh | max
```

OpenCode 2 передаёт explicit effort как `#<effort>` без silent downgrade.
Фактическая доступность variant определяется выбранной upstream catalog model.
Если variant отсутствует, beta возвращает явный `VariantUnavailableError`;
Triss сохраняет его как execution error, а не повторяет запрос с другим
effort.

Исправление не будет выдумывать generic variant definitions:
`reasoningEffort` и допустимые уровни зависят от provider/package/model, а
command layer по принятому provider-neutral contract не содержит такую
матрицу. Для текущего synthetic `@ai-sdk/openai-compatible` GLM-5.2
квалифицируются `high` и `max`; unsupported значения должны завершаться явной
model-specific ошибкой до provider request.

Active OpenCode 2 guide должен объяснять эту границу. Это устраняет ложное
впечатление, что совместимый binary гарантирует поддержку каждой
model/effort пары.

## Инварианты

1. OpenCode 2 не фиксируется на exact build: текущий floor
   `0.0.0-beta-19059` и все более новые parseable версии поддерживаются при
   наличии required CLI surface; configured minimum может только повысить floor.
2. `next`, `dev` и `tui` prerelease channels по-прежнему отклоняются.
3. Probe запускает только `--version` и `run --help` в изолированном HOME/XDG.
4. Probe не запускает `debug config` и не оставляет новый
   `opencode2 serve --service`.
5. Absolute canonical executable, regular executable file и same-binary
   post-run проверки не меняются.
6. Отсутствие complete `--standalone`, `--format`, `--auto` или `--model`
   option declarations остаётся fail-closed; help description text не является
   compatibility gate.
7. Explicit effort нормализуется, не теряется и не понижается молча.
8. Unsupported model-specific variant возвращает явную execution error.
9. Omitted effort сохраняет native default и не добавляет `#`.
10. Provider route, credential isolation, transient overlay, proxy pin,
    envelope, usage и persisted identities используют base model.
11. Pre-suffixed OpenCode 2 main model отклоняется до side effects.
12. OpenCode 1, OMP и Crush effort mappings не меняются.

## Нецели

- exact version pinning или отклонение совместимой версии только потому, что
  она новее текущего floor;
- поддержка `dev`, `next` или `tui-v2` channels;
- изменение общего списка effort levels;
- сохранение pre-suffixed model как public OpenCode 2 API;
- глобальный запрет `#` в model IDs других engines;
- создание непроверенных generic variant definitions;
- command/provider capability matrix для model-specific variants;
- изменение provider registry, endpoint routing, credential modes, sessions
  или usage accounting;
- ослабление capability probe до проверки одной версии;
- поддержка будущего отдельного `--variant` без новой квалификации.

## Изменения по файлам

### `src/coder-engines/opencode2.js`

- исправить verified-contract comments;
- удалить `--variant` из списка отдельных required options;
- распознавать required option declarations при разных presentation formats;
- не использовать `provider/model#variant` help prose как compatibility gate;
- возвращать отсутствующие option names в `capabilities.missing`;
- добавлять `#<effort>` к значению `--model`, не создавая отдельный flag;
- сохранить argument order и session checks.

### `src/commands/coder.js`

- отклонять `#` в resolved OpenCode 2 base main model сразу после model
  resolution и до side effects;
- передавать в adapter `selectedModel.effort`, не raw `opts.effort`;
- не менять route, overlay, proxy и envelope model values.

### `test/fixtures/opencode2-run-help-beta-19059.txt`

Добавить verbatim `beta-19059` help без ANSI. Рядом зафиксировать provenance:
capture command, package version, Darwin arm64 и дату. Fixture не содержит
синтетический `--variant`.

### `test/opencode2-version-capability.test.js`

- positive probe читает beta-19059 fixture;
- help без отдельного `--variant` и без фиксированной variant-фразы проходит;
- `Flags:`, `FLAGS:`, ANSI heading и неодинаковые отступы проходят;
- declarations с несколькими long aliases проходят;
- `--model-old` без `--model` не проходит;
- option-like text вне FLAGS sections не создаёт required records;
- nonzero `run --help` не проходит даже с валидным text;
- missing option возвращается по имени;
- version/channel/service-process regressions используют реальный surface
  shape.

### `test/coder-opencode2.test.js`

- capability stubs используют beta-19059 model record;
- direct argv tests проверяют suffix, отсутствие отдельного flag,
  omitted-effort base selector, prompt-last и session matrix;
- orchestration test с protected routing и explicit `high` проверяет:
  - argv `triss-coder-transient/glm-5.2#high`;
  - base-only overlay model и model key;
  - base-only proxy `model` и `models`;
  - base-only requested/engine/usage/billing identities;
- programmatic `" HIGH "` даёт ровно `#high`;
- omitted-effort orchestration case сохраняется;
- explicit и configured base models с `#` отклоняются до proxy/session/spawn;
- model-specific `VariantUnavailableError` остаётся явной engine error без
  retry/downgrade.

### `test/engine-effort.test.js`

- OpenCode 2 для всех пяти logical values проверяется как suffix значения
  после `--model`;
- тест утверждает transport без silent remapping, а не универсальную
  доступность variant для любой model;
- OpenCode 1 остаётся на отдельном `--variant`;
- native-default case проверяет отсутствие suffix.

### Все OpenCode 2 capability stubs

Полный затрагиваемый список:

- `test/opencode2-version-capability.test.js`;
- `test/coder-opencode2.test.js`;
- `test/coder-opencode2-init.test.js`;
- `test/coder-opencode2-run-preflight.test.js`;
- `test/opencode2-lifecycle-regressions.test.js`;
- `test/opencode2-provenance-regressions.test.js`.

Каждый inline help stub переводится на один beta-19059 contract. Это
механическая синхронизация fixture, не изменение тестируемой lifecycle или
provenance семантики.

### `test/status-opencode2.test.js`

Добавить детерминированный test для credential-gated Coder block:

- isolated fake credential включает блок;
- injected binary/version/help возвращают beta-19059 surface;
- compatible строка отображается;
- реально отсутствующий required option отображается как incompatible;
- тест доказывает, что status действительно вызвал OpenCode 2 probe.

### `docs/engines/opencode2.md`

Уточнить:

- beta-19059 transport syntax — `--model provider/model#variant`;
- status compatibility относится к CLI surface;
- variant availability model-specific;
- unsupported explicit effort завершается ошибкой и не downgrades.

### `CHANGELOG.md`

В `[Unreleased] / Fixed` зафиксировать:

- текущий beta снова проходит capability check;
- OpenCode 2 effort передаётся через `provider/model#variant`;
- pre-suffixed public/configured OpenCode 2 models отклоняются до side effects.

## Последовательность реализации

1. Добавить verbatim beta-19059 fixture и красные capability/status/argv
   assertions.
2. Добавить красные orchestration tests для normalized effort, base identity и
   pre-suffixed model rejection.
3. Исправить option-record probe и argv builder в OpenCode 2 adapter.
4. Добавить раннюю OpenCode 2 base-model boundary и normalized effort
   forwarding в coder orchestration.
5. Синхронизировать шесть capability-stub suites с реальным help surface.
6. Обновить active engine guide и changelog.
7. Выполнить targeted tests.
8. Квалифицировать реальный beta-19059 через local loopback.
9. Выполнить credential-gated status smoke и repository validation.

## Проверка

### Targeted contract tests

```bash
node --test \
  test/opencode2-version-capability.test.js \
  test/coder-opencode2.test.js \
  test/coder-opencode2-init.test.js \
  test/coder-opencode2-run-preflight.test.js \
  test/opencode2-lifecycle-regressions.test.js \
  test/opencode2-provenance-regressions.test.js \
  test/engine-effort.test.js \
  test/status-opencode2.test.js
```

Они доказывают:

- beta-19059 help квалифицируется;
- option-like text вне FLAGS sections и `--model-old` не квалифицируются;
- normalized explicit effort попадает только в runtime selector;
- omitted effort оставляет base selector;
- route/overlay/proxy/envelope/usage identities остаются base-only;
- pre-suffixed main model не достигает side effects;
- status действительно проходит credential-gated Coder path;
- остальные version, service, lifecycle, provenance и preflight gates не
  меняются.

### Beta-19059 loopback qualification

Одноразовый hermetic smoke использует:

- реальный canonical `opencode2 v0.0.0-beta-19059`;
- temporary HOME/XDG roots;
- `--standalone`;
- dummy credential;
- local `127.0.0.1` capture server;
- тот же transient provider/model overlay, который строит Triss;
- before/after service PID snapshot.

Проверки:

1. `triss-coder-transient/glm-5.2#high` разрешается;
2. outbound request содержит base model `glm-5.2`, не suffixed selector;
3. request содержит квалифицированную high reasoning setting;
4. local response завершает run без внешней сети;
5. unsupported variant case возвращает `VariantUnavailableError` до outbound
   provider request и не downgrades;
6. после обоих запусков нет нового resident service.

Если фактический binary нарушает пункты 1–3, реализация не считается готовой:
нельзя заменять behavioral proof одним argv test или объявлять status
compatible с заявленным effort contract.

### Credential-gated status smoke

```bash
TRISS_OPENAI_COMPATIBLE_API_KEY=status-probe node bin/triss.js status
```

Команда не делает provider request. При установленном beta-19059 она обязана
показать `opencode2 ... (compatible)`, не `missing --variant`. Проверка
resident-service остаётся частью `detectOpenCode2`.

### Repository checks

```bash
npm run lint
npm run typecheck
npm test
npm run check:docs
npm run check:package
npm run check:license-headers
```

Финальный repository search должен подтвердить: production OpenCode 2 adapter
и current fixtures не рекламируют отдельный `--variant`; оставшиеся совпадения
относятся к OpenCode 1, changelog или историческому описанию дефекта.

## Критерии приёмки

1. Credential-gated `status` с beta-19059 показывает OpenCode 2 compatible.
2. Capability probe fail-closed проверяет whole option records и variant
   grammar именно внутри `--model`.
3. `effort=high` создаёт `--model <base>#high` без `--variant high`.
4. Programmatic effort нормализуется через shared model-selection result.
5. Omitted effort передаёт ровно base selector.
6. Все пять public effort values транспортируются без silent remapping;
   model-specific отсутствие variant возвращает явную execution error.
7. Canonical, route, overlay, proxy, envelope, usage и persisted identities
   остаются base-only.
8. Explicit/configured pre-suffixed OpenCode 2 main model отклоняется до
   side effects.
9. Реальный beta-19059 loopback подтверждает high variant semantics, base
   outbound model и отсутствие resident service.
10. Ни одна security, process, version, provider или session gate не ослаблена.
11. Targeted tests, status smoke и repository checks проходят.
