# План: дефолтный credential mode `best_effort_raw` и флаг `--protect-credentials`

Под **текущим режимом** ниже понимается `protected_proxy`: Triss поднимает родительский loopback-прокси, передаёт движку одноразовый токен и применяет строгие проверки конфигурации. Новым режимом по умолчанию становится `best_effort_raw`, то есть текущее поведение при `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1`.

Сейчас логика обратная: только буквальное значение `1` включает `best_effort_raw`, а при любом другом значении выбирается `protected_proxy`; значение перечитывается с учётом shell/local/global precedence. При этом в `triss coder init` и `triss coder run` отдельного флага для выбора credential mode сейчас нет.

Название нового флага: `--protect-credentials`.

## 1. Зафиксировать новый публичный контракт

Целевая матрица поведения:

| Движок      | Без флага         | С `--protect-credentials`                              |
| ----------- | ----------------- | ------------------------------------------------------ |
| `opencode`  | `best_effort_raw` | `protected_proxy`                                      |
| `opencode2` | `best_effort_raw` | `protected_proxy`                                      |
| `crush`     | `protected_proxy` | `protected_proxy` — флаг допустим, но ничего не меняет |

Для OpenCode в режиме по умолчанию:

* движок получает только credential выбранного provider;
* credential proxy не запускается;
* сохраняются проверки структуры конфигурации, привязки provider/model/endpoint/package и очистка остальных credentials из child environment;
* плагины, agents, custom tools и обычная shell policy разрешаются после структурных проверок;
* envelope продолжает честно сообщать, что credential isolation недоступна.

Для `--protect-credentials` необходимо сохранить нынешнее поведение без ослаблений:

* parent-owned credential proxy;
* одноразовый токен вместо исходного ключа;
* только проверенные transport routes;
* fail-closed проверка читаемых `.triss.env`;
* строгие проверки plugins, agents, tools и bash policy;
* отказ до spawn, если proxy или требуемая изоляция недоступны.

Именно эти различия уже реализованы между двумя внутренними режимами. Для OpenCode 2 protected mode дополнительно требует deny-everything shell policy и отклоняет executable surfaces, тогда как best-effort разрешает обычную V1 policy и передаёт raw credential.

## 2. Сделать один централизованный resolver

В `src/coder-providers.js` заменить env-driven контракт на explicit-option contract:

```js
export function resolveCoderCredentialMode({
  protectCredentials = false,
  engine,
} = {}) {
  if (engine === 'crush') return 'protected_proxy';

  return protectCredentials
    ? 'protected_proxy'
    : 'best_effort_raw';
}
```

Требования:

* только верхнеуровневый resolver определяет default;
* внутренние функции получают уже вычисленный `credentialMode`;
* убрать скрытые значения по умолчанию вроде `credentialMode = 'protected_proxy'` из `runCoderSetupUnlocked`, OpenCode 2 preflight и других внутренних helpers;
* валидировать допустимые значения `best_effort_raw | protected_proxy`;
* не позволять разным путям — `init`, `run`, wizard или MCP — вычислять режим независимо.

`readCoderCredentialMode()` в `src/config.js` больше не должен управлять поведением. Его можно временно оставить только для обнаружения старой переменной и показа migration warning.

## 3. Добавить флаг во все пользовательские entry points

### CLI

В `bin/triss.js` добавить:

```text
triss coder run --protect-credentials
triss coder init --protect-credentials
triss exec --code --protect-credentials
```

Help:

```text
--protect-credentials
Use the parent-owned credential proxy and strict executable-surface gates.
Fails closed when protected credential isolation cannot be enforced.
OpenCode/OpenCode2 only; Crush is always protected.
```

Для wizard добавить prefixed option:

```text
triss config wizard coder \
  --coder-engine opencode2 \
  --coder-protect-credentials
```

### `triss exec`

В `src/commands/exec.js`:

* добавить `protectCredentials` в `ROUTE_OPTION_SUPPORT` только для coder route;
* включить его в `coderOptions()`;
* обеспечить передачу без преобразования в `runCoderRun`;
* добавить тест для `--explain`, чтобы флаг не принимался на `ask`, `review` или `chat`.

### MCP

В `triss_coder_run` добавить boolean `protectCredentials`. Затем:

* добавить поле в `src/mcp/tools.js`;
* принять его в `coderRunHandler`;
* передать в `runCoderRun`;
* обновить описание MCP tool, указав, что default — `best_effort_raw`.

## 4. Протащить explicit mode через `init` и setup

В `src/commands/coder.js`: каждый уровень цепочки `runCoderInit / runOpenCode2Init → runCoderSetup → runCoderSetupUnlocked → config audit / preflight` должен получать уже разрешённый `credentialMode`.

`triss coder init --engine opencode2` создаёт best-effort-compatible конфигурацию (обычный V1 allowlist, structural и provider checks остаются).

`triss coder init --engine opencode2 --protect-credentials` воспроизводит прежний default (deny-everything bash policy, preflight executable surfaces, полный post-setup audit).

Если пользователь сделал best-effort init, а затем запускает `run --protect-credentials`, несовместимая allow policy отклоняется с remediation:

```text
Re-run `triss coder init --engine opencode2 --protect-credentials`
or remove `--protect-credentials` to use the default best-effort mode.
```

## 5. Переключить runtime без дублирования старой логики

В `runCoderRun` разрешать mode из options через `resolveCoderCredentialMode({ engine, protectCredentials })`; существующие ветки продолжают работать по mode. Дополнительно:

* убрать production-зависимость от test seam `deps.allowBestEffortIsolation`;
* заменить `credentialModeParentEnv` в тестах на явный `protectCredentials` либо прямой injected `credentialMode`;
* raw-store preflight исключительно при `protected_proxy`;
* credential proxy для OpenCode в режиме по умолчанию не запускается;
* Crush остаётся на обязательном proxy независимо от флага;
* unaudited Zen/Go routes: raw default может использовать built-in provider metadata, protected mode обязан отклонить непроверенный transport.

## 6. Обновить сообщения и observability

Все подсказки вида `set TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION=1` заменить на `rerun without --protect-credentials` или `run `triss coder init` without --protect-credentials`.

В `triss coder status` и MCP status добавить строку:

```text
Default credential mode: best_effort_raw
Protected mode: pass --protect-credentials
```

Envelope сохранить: `execution_capabilities.credential_isolation = "unavailable"` для default raw, существующее protected значение для proxy mode, warning о доступности raw credential.

Warning code `TRISS_CODER_CREDENTIAL_ISOLATION_DOWNGRADED` оставить для совместимости, но изменить текст на:

```text
best_effort_raw credential mode is active by default; the selected raw
provider credential may be read by same-UID engine code, plugins, tools,
or shell commands. Pass --protect-credentials to enable protected_proxy.
```

## 7. Миграция старой env-переменной

1. Поведение больше не зависит от значения `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION`.
2. Значение `1` принимается как устаревший no-op.
3. Значение `0` не включает protected mode.
4. При непустом legacy value выводить migration warning раз за команду.
5. Оставить ключ в `NON_SECRET_CODER_STORE_KEYS`.
6. Удаление variable reader — в отдельном cleanup-релизе (`triss config unset TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION [--global|--local]`).

## 8. Тестовый план

Resolver: матрица движков × флаг; legacy env unset/0/1 не меняет режим.

Runtime: default raw без proxy; child получает только credential выбранного provider; readable store не блокирует default raw; `--protect-credentials` запускает proxy и скрывает исходный key; protected + readable store отклоняется до spawn; ошибка proxy в protected mode отклоняет до spawn; Zen/Go route raw разрешён, protected отклонён; envelope/stderr отражают mode.

OpenCode 2: default init normal allowlist; default run разрешает plugins/agents/custom tools после shape checks; protected init deny-everything; protected run блокирует executables; protected run против best-effort config даёт actionable remediation.

Entry points: help содержит флаг у `coder run`, `coder init`, `exec`; exec forwards; wizard forwards; MCP schema и handler передают; Crush — неизменный обязательный proxy.

Suites: `test/coder-provider-registry.test.js`, `test/coder-isolation-gate.test.js`, `test/coder-best-effort-routing-matrix.test.js`, `test/coder-init.test.js`, `test/coder-opencode2-init.test.js`, `test/coder-opencode2.test.js`, `test/opencode2-provenance-regressions.test.js`, `test/opencode2-model-state-regressions.test.js`, `test/coder-envelope.test.js`, `test/mcp-coder.test.js`, `test/wizard-full.test.js`.

Тесты `--allow-best-effort-caller-worktree` остаются без изменений.

## 9. Документация

Обновить: `README.md`, `docs/configuration.md`, `docs/engines/opencode2.md`, `docs/mcp.md`, `docs/glm-clients.md`, `docs/reliable-delegation-contract.md`, `templates/claude-full.md`, `site/src/pages/coder.astro`, `CHANGELOG.md`.

После правок — репозиторный поиск по `TRISS_CODER_ALLOW_BEST_EFFORT_ISOLATION`, `protected mode is the default`, `Explicit best-effort mode`, `acknowledge the best-effort scope`: в активной документации их быть не должно (допустимо только в migration/changelog).

## Критерии готовности

1. Bare `triss coder run` для OpenCode/OpenCode2 использует `best_effort_raw` без env-переменной.
2. `--protect-credentials` полностью воспроизводит прежний `protected_proxy` path.
3. `init`, `run`, `exec`, wizard и MCP используют один resolver и одинаковую семантику.
4. Crush по-прежнему никогда не передаёт raw credential движку.
5. Старый env-флаг не влияет на режим и не ломает protected store audit.
6. Ошибки больше не рекомендуют устанавливать legacy env variable.
7. Worktree isolation flags ортогональны и неизменны.
8. Focused tests и полный `npm test` проходят.
