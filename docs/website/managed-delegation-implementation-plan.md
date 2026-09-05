# План: Triss как слой управляемого делегирования для AI-разработки

Дата решения: 2026-09-05. Статус: план реализации; изменения сайта ещё не выполнены.

## 1. Назначение и инструкция исполнителю

Владелец выбрал позиционирование **«Слой управляемого делегирования для AI-разработки»**. Этот документ переводит решение в конкретные изменения сайта. Продуктовые решения, порядок блоков, маршруты, основные тексты, ограничения и критерии приёмки заданы ниже. Не придумывать другую концепцию.

План написан по-русски; весь публичный сайт остаётся на английском (`lang="en"`). Английские тексты в кавычках ниже — зафиксированный этим планом copy deck для исполнителя, а не примеры для свободной переписи. Владелец утвердил позиционирование; конкретные тексты и layout предложены в этом плане, а не отдельно согласованы с ним. Допустимы грамматические исправления без изменения смысла. Реальные результаты модели нельзя заранее сочинить: порядок их получения определён отдельно.

Работать по задачам W01–W14 последовательно. До начала каждой задачи прочитать её целиком и только перечисленные исходники. Отмечать задачу выполненной сразу после выполнения критериев, записывать проверку и её результат. Если используются несколько исполнителей, передавать каждому разделы 1–5, его задачу и зависимости; не поручать нескольким исполнителям одновременно один файл.

Не останавливаться после homepage: завершённый результат включает сценарии, quickstart, согласованную вторичную документацию, social preview и проверки. Не коммитить и не публиковать без отдельного поручения владельца.

### Рабочая среда

- Worktree: `/Volumes/Orange/Projects/.worktrees/triss/website-managed-delegation/`.
- Ветка: `docs/website-managed-delegation`.
- База при создании: `origin/main`, `3208b6d` (`feat(runtime): persist model execution engine (#113)`).
- Репозиторий: `https://github.com/ayleen/triss-coworker`.
- Публичный сайт: `https://triss.work/`.
- Источники сайта: `site/`; статический Astro, Cloudflare Workers Static Assets.
- В исходном checkout есть чужие незакоммиченные изменения: не переносить их автоматически, не сбрасывать и не редактировать исходный checkout.

**Общее правило владельца для всех проектов:** новые рабочие Git worktree создавать только внутри `/Volumes/Orange/Projects/.worktrees/{имя проекта}/{имя задачи}/`. Для этого проекта имя проекта — `triss`, не имя GitHub-репозитория и не имя ветки. Не использовать старые соседние каталоги `triss-*` и `.claude/worktrees/` для новых рабочих checkout. Не перемещать уже существующие worktree без отдельного поручения. Это правило размещения рабочих checkout; данный сайт-план не меняет внутренний storage/runtime `triss coder` и `.triss/wt`.

### Источники истины и порядок при конфликте

1. Прямые решения владельца и binding rules в `AGENTS.md`.
2. Этот план для позиционирования, состава страниц и acceptance сайта.
3. Фактический CLI/MCP-контракт текущей реализации для синтаксиса команд и реально доступного поведения.
4. Актуальные `README.md`, `docs/configuration.md`, `docs/mcp.md`, `docs/data-flows.md`, документация движков.
5. Старые требования сайта — только там, где они не противоречат новому решению.

До изменений прочитать `AGENTS.md`, `CONTRIBUTING.md`, `ARCHITECTURE.md`.

В исходном checkout прочитано принятое решение `docs/adr/2026-09-05-user-choice-and-easy-setup.md`; на момент планирования оно было незакоммиченным. Не зависеть от наличия этого файла в чужом checkout. Его обязательный смысл для этого плана:

- Пользователь выбирает provider, model и engine; не заменять выбор молча.
- Недостаток проверенных гарантий сам по себе не основание запрещать исполнимый маршрут. Best effort сопровождается точным объяснением ограничений; имеющиеся защиты сохраняются.
- Явно требуемую пользователем гарантию не ослаблять молча.
- Easy — короткий рекомендуемый путь; Advanced — доступная дополнительная настройка, а не обязательная административная панель.
- Повторная настройка сохраняет явные пользовательские решения.
- Это направление продукта, не утверждение, что все адаптеры и Easy UI уже реализованы. Сайт не должен симулировать ещё отсутствующий wizard или объявлять неработающий маршрут работающим.

Если актуальная версия всё ещё не умеет некоторый маршрут, описывать это как ограничение **текущей версии** в технической документации, а не как вечный запрет или причину навязать другую модель. Исправление runtime не входит в эту задачу.

## 2. Что именно меняем

### Проблема

Сейчас главная продаёт разницу тарифов: expensive proofreader, калькулятор, проценты экономии, цена вызова. Продукт при этом уже предлагает общий CLI/MCP-интерфейс к операциям чтения, ревью, исполнения и интеграциям. Сайт объясняет цену раньше результата и устройства пользовательского процесса.

### Принятое обещание

- Категория: **Managed delegation for AI development**.
- Главный headline: **Give your coding agent a coworker.**
- Главная ценность: делегировать ограниченные части AI-разработки, выбирать модели и движки, проверять результат перед принятием.
- Экономия — вторичное преимущество, зависящее от конкретного маршрута и задачи.
- Triss — локальный open-source CLI и MCP server, не новая обязательная IDE, не hosted AI service и не самостоятельная команда сотрудников.

### Аудитория

Первичная: разработчик, уже использующий Claude Code или Codex, которому нужно делегировать исследование, второе мнение по изменениям или ограниченную реализацию через выбранные инструменты.

Вторичная: maintainer или небольшая команда, желающие повторяемых рабочих процессов и общего интерфейса к поддерживаемым моделям, движкам и трекерам.

Не расширять в этом изменении аудиторию до маркетологов, всех knowledge workers, enterprise fleet management или пользователей без опыта разработки.

### В границах работы

- Новая главная и главное обещание.
- Один реальный, вручную проверенный пример чтения кода.
- Каталог из трёх сценариев и три законченные страницы сценариев.
- Более короткий quickstart с выбором Claude Code / Codex / Terminal.
- Согласование Coder, Integrations, Security, Cost, Documentation, Commands.
- Новая social-card картинка и metadata; обновление требований сайта.
- Сохранение существующего статического стека, доступности, security headers и CI.

### Вне границ работы

- Изменение CLI/MCP schemas, адаптеров, sandbox, provider runtime, wizard implementation.
- Автоматический выбор самой дешёвой/качественной модели, scheduler, parallel agent team, автоматические цепочки задач.
- Backend, логин, dashboard, платежи, приём пользовательского кода или API keys в браузере.
- CMS, React/Vue, новые runtime-зависимости, полный перенос всех `docs/` на сайт.
- Ребрендинг логотипа/маскота, смена домена, редизайн всей дизайн-системы.
- Новая аналитическая система, события установок, cookies, replay, сбор реальных CLI-логов посетителей.
- Сравнительный benchmark качества всех моделей. Один case study не является benchmark.

## 3. Контракт публичных утверждений

| Допустимо | Основание / обязательное уточнение | Не писать |
| --- | --- | --- |
| Delegate research, review, and implementation | CLI `ask`, `review`, `coder run`; ограниченная задача и проверяемый результат | Triss autonomously manages your engineering team |
| Choose your models and coding engines | Общий provider runtime; поддерживаемые комбинации и текущие ограничения в справочнике | Every model works with every engine today |
| Keep control of what ships | Человек/основной агент проверяет изменения и принимает решение | Triss guarantees correct code |
| Return focused findings with source references | Реальная задача `ask`; ссылки нужно проверять | Never loses important context |
| Review changes in an isolated Git worktree | Только для явно изолированного запуска с подтверждённым результатом | A worktree confines access to your entire filesystem |
| Local CLI, no developer telemetry | `docs/data-flows.md`; выбранный контекст может уйти провайдеру | Your code never leaves your machine |
| Lower inference cost can be a benefit | `/cost`, методика, provider/model/date/cache assumptions | Always cheaper / 60% off your Claude subscription |
| CLI and MCP share a configuration contract | `README.md`, `docs/mcp.md` | Triss automatically intercepts all agent activity |
| Track model usage and recorded costs | Неизвестная цена остаётся неизвестной | Missing cost means free |

Удалить утверждение `routes to the cheapest model that can do it`: `src/model-selection.js` разрешает явный/настроенный выбор, а не ранжирует кандидатов по цене и качеству.

Слова `managed` и `control` означают явный выбор, ограниченную задачу, наблюдаемый результат и решение о принятии. Они не означают новые enforcement-гарантии.

DeepSeek, GLM, Kimi, Muse и другие модели разрешены в технических примерах. Не удалять реальные сведения о DeepSeek с `/cost` ради новой маркировки. Не объявлять одну модель обязательной для Triss.

Правило совместимости OpenCode 2 сохраняется: поддерживаемая текущая нижняя граница и более новые версии, не точная фиксация сборки. Значения брать из актуального контракта, а не распространять старое число по новым страницам.

## 4. Итоговая информационная архитектура

### Маршруты

| URL | Файл | Решение |
| --- | --- | --- |
| `/` | `site/src/pages/index.astro` | Переписать под новую историю |
| `/workflows/` | `site/src/pages/workflows/index.astro` | Создать, каталог трёх сценариев |
| `/workflows/research/` | `site/src/pages/workflows/research.astro` | Создать, чтение выбранного кода |
| `/workflows/review/` | `site/src/pages/workflows/review.astro` | Создать, второе мнение по изменениям |
| `/workflows/implementation/` | `site/src/pages/workflows/implementation.astro` | Создать, запуск → проверка → принятие/отказ |
| `/docs/getting-started/` | `site/src/pages/docs/getting-started.astro` | Упростить, сохранить альтернативы |
| `/docs/` | `site/src/pages/docs/index.astro` | Сделать явной точкой входа в документацию |
| `/coder/` | `site/src/pages/coder.astro` | Справочник исполнения, без cheap-model lead |
| `/integrations/` | `site/src/pages/integrations.astro` | Контекст задачи и явные операции |
| `/security/` | `site/src/pages/security.astro` | Краткая модель доверия перед деталями |
| `/cost/` | `site/src/pages/cost.astro` | Сохранить калькулятор и методику |
| `/commands/` | `site/src/pages/commands.astro` | Сохранить справочник и поиск |
| неизвестный URL | `site/src/pages/404.astro` | Сохранить настоящий 404 |

Не переименовывать существующие URL. Сохранить homepage anchors `#top`, `#how`, `#commands`, `#install`; `#commands` может стать коротким переходом к справочнику без старого интерактивного preview.

### Навигация

Одинаковая последовательность для desktop и mobile:

1. Workflows → `/workflows/`.
2. Quickstart → `/docs/getting-started/`.
3. Docs → `/docs/`.
4. Coder → `/coder/`.
5. Integrations → `/integrations/`.
6. Cost → `/cost/`.
7. Security → `/security/`.

GitHub остаётся отдельной существующей ссылкой. Commands доступны с главной, `/docs/` и страниц сценариев. How it works остаётся секцией `/#how`, а не ещё одним обязательным пунктом верхнего меню.

`Header` получает значения `current="workflows"` и `current="docs"`; на всех detail workflow-страницах активен Workflows. На `/docs/` не должен подсвечиваться Quickstart. Обновить обе существующие разметки `#main-nav` и `#mobile-nav`, не только desktop.

### Главная: строгий порядок секций

1. Hero: категория, headline, пояснение, primary/secondary CTA, install command; справа реальный статический пример.
2. Три workflow cards: Research / Review / Implementation.
3. `#how`: роли основного агента, Triss, выбранных исполнителей, проверка результата.
4. Why add Triss to an agent you already use? — ответ про встроенные tools/subagents.
5. Controls and boundaries — четыре кратких ответа о выборе и данных.
6. Cost is one part of the decision — короткий блок со ссылкой на `/cost/`.
7. `#commands`: ссылка на справочник без числа команд в заголовке.
8. `#install`: установка и Quickstart, ссылки на docs/GitHub.

Не переносить старый калькулятор вниз главной: на главной его больше нет вообще. Не дублировать все таблицы провайдеров на первом экране.

## 5. Готовые тексты и визуальные решения

### Hero

Eyebrow: `Managed delegation for AI development`

H1: `Give your coding agent a coworker.`

Paragraph: `Delegate codebase research, reviews, and implementation through Triss. Use your preferred models and coding engines. Keep control of what ships.`

Supporting line: `An open-source CLI and MCP server for Claude Code, Codex, and your terminal.`

Primary CTA: `Get started` → `/docs/getting-started/`.

Secondary CTA: `See a real example` → `#delegation-example`.

Copyable install: `npm install -g triss-coworker`, видимая подпись кнопки `Copy install command`.

Не показывать `Node`, version, model prices, token counts, provider setup и install-method selector в роли основного объяснения продукта. Требование Node оставить рядом с установкой/quickstart.

### Workflow cards

| Title | Body | CTA |
| --- | --- | --- |
| Understand unfamiliar code | Ask a focused question about selected files and bring source-backed findings into your main agent's context. | Explore research workflow |
| Get a second review | Review a branch or pull request, inspect each finding, and decide what needs to change. | Explore review workflow |
| Delegate a bounded change | Run an implementation task through a coding engine, inspect the resulting changes, and accept only what you have verified. | Explore implementation workflow |

### How it works

H2: `Delegate the work. Keep the decisions.`

Четыре шага, в таком порядке:

1. `Your agent defines the task` — `Choose the question, context, and acceptance criteria.`
2. `Triss invokes the configured route` — `Use the selected provider, model, and execution engine through CLI or MCP.`
3. `You receive a result to inspect` — `Read findings, source references, or implementation changes.`
4. `You decide what to use` — `Verify the evidence and changes before accepting them.`

Рисовать обычным HTML ordered list / cards; не добавлять Mermaid runtime или графическую библиотеку. Не изображать автоматический feedback loop, worker-to-worker routing или автоматический merge.

### Ответ про существующие агенты

H2: `Why add Triss to an agent you already use?`

Intro: `Keep your existing agent. Use Triss when you want a shared interface for delegated work across supported models, coding engines, and project tools.`

Три пункта:

- `A common interface` — `Use the same provider configuration through CLI and MCP.`
- `Task-specific workflows` — `Read selected context, review changes, or delegate an implementation task without inventing a new prompt-and-script workflow each time.`
- `Results you can inspect` — `Keep findings, changes, execution details, and usage information available for review.`

Заключение: `If your agent's built-in tools already meet your needs, you may not need another layer. Triss is useful when you want explicit delegation and a common interface across tools.`

Не делать неподтверждённую сравнительную таблицу функций Claude Code/Codex и не заявлять их отсутствие у конкурентов.

### Controls and boundaries

H2: `Your choices. Clear boundaries.`

- `Models and engines` — `Choose the supported provider, model, and engine for the work. Check the configuration guide for current route requirements.` → docs configuration.
- `Data` — `Selected code and task context may be sent to your model provider. Triss has no developer telemetry.` → `/security/`.
- `Execution` — `A Git worktree separates changes. It is not an operating-system sandbox.` → `/coder/`.
- `Acceptance` — `A completed run is not proof that a task is correct. Review the result before using it.` → implementation workflow.

### Cost

H2: `Cost is one part of the decision.`

Paragraph: `Delegating to a lower-cost model can reduce inference spend. The result depends on the task, selected model, cache usage, and any retries. Compare the assumptions, not just the headline.`

CTA: `Explore costs and methodology` → `/cost/`.

Не публиковать универсальный процент или стоимость вызова на главной. Исторический кейс остаётся на `/cost/` с исторической атрибуцией.

### Metadata

| Страница | Title | Description |
| --- | --- | --- |
| Home | Triss — Managed delegation for AI development | Delegate codebase research, reviews, and implementation through a local CLI and MCP server. Choose your models and engines. Keep control of what ships. |
| Workflows | AI development workflows — Triss | Learn how to delegate codebase research, code review, and bounded implementation tasks with Triss. |
| Research | Delegate codebase research — Triss | Ask focused questions about selected files, inspect source references, and use verified findings in your development workflow. |
| Review | Get a second code review — Triss | Review a branch or pull request with Triss, verify each finding, and decide which changes to make. |
| Implementation | Delegate an implementation task — Triss | Run a bounded coding task, inspect worktree changes and execution results, and accept only verified work. |
| Quickstart | Get started with Triss | Install Triss, connect your chosen provider and agent, and complete your first delegated research task. |
| Coder | Coding engines and execution — Triss | Run implementation tasks through supported coding engines and understand worktree isolation, results, and verification. |
| Integrations | Project context and integrations — Triss | Read project context and perform explicit operations with GitHub, GitLab, Jira, Linear, and Confluence through Triss. |
| Cost | Inference costs and methodology — Triss | Explore a measured Triss usage example and an API-cost calculator with explicit pricing and workload assumptions. |

Для Docs, Commands, Security сохранить уникальный нейтральный title/description, если он не противоречит разделу 3. `Base.astro` уже распространяет title/description в Open Graph; не добавлять второй набор тегов.

`site/public/site.webmanifest` description: `Managed delegation for AI development through a local CLI and MCP server.`

### Визуальное исполнение

- Сохранить цвета `tokens.css`, локальные IBM Plex Sans/Mono, логотип/маскот и общий тёмный стиль.
- Для новых layouts использовать явные классы `.home-hero`, `.workflow-grid`, `.workflow-layout`, `.delegation-example`, а не новые CSS selectors по строкам inline-style.
- Hero: desktop две колонки `minmax(0, 1.05fr) minmax(0, 0.95fr)`, gap 48px; при ширине <=900px одна колонка; на мобильном текст/CTA раньше примера.
- H1: `clamp(2.25rem, 4.5vw, 3.875rem)`, line-height около 1.05; основной текст >=16px.
- Три workflow cards: 3 колонки desktop, 2 при <=900px, 1 при <=640px; `min-width: 0` у grid children.
- Основной текст scenario-page: max-width около 72ch; code blocks имеют собственный horizontal scroll, не расширяют страницу.
- Все touch-controls >=44 CSS px, видимый focus, ссылки отличимы от обычного текста.
- Не добавлять autoplay, typing animation, carousel, video embed, runtime AI demo.
- Весь смысловой контент, команды и ссылки присутствуют в HTML сборки без JavaScript. Под SSR в этом плане понимается Astro build-time rendering, не серверный backend.

## 6. Карта файлов и зависимостей

### Существующие файлы, которые потребуется изменить

| Файл | Конкретная работа |
| --- | --- |
| `site/src/pages/index.astro` | Новая структура; убрать pricing frontmatter, calculator DOM и pricing-data; сохранить anchors |
| `site/public/scripts/pricing-index.js` | Удалить после переноса только нужного copy-handler; preview/install tabs на главной удаляются |
| `site/src/components/Header.astro` | Оба меню, новые active keys, без поломки мобильного disclosure |
| `site/src/styles/global.css` | Только стили новых секций/сценариев и нужная адаптивность |
| `site/src/pages/docs/getting-started.astro` | Короткий маршрут, статические панели, перенос advanced material ниже |
| `site/public/scripts/getting-started.js` | Только progressive enhancement, без копий команд/фиктивных outputs |
| `site/src/pages/docs/index.astro` | Docs active state, сценарии, точные ссылки, убрать устаревшие README anchors |
| `site/src/pages/coder.astro` | Новая вводная, ссылка на end-to-end workflow, честные capability explanations |
| `site/src/pages/integrations.astro` | Статическая схема read/explicit write и setup links |
| `site/public/scripts/integrations-tabs.js` | Сохранить interaction; изменять только затронутые claims и broken command formatting |
| `site/src/pages/security.astro` | Статическая сводка trust boundary и ссылка на data-flows |
| `site/public/scripts/security-topics.js` | Исправить лишь конфликтующие утверждения, не переписывать security subsystem |
| `site/src/pages/cost.astro` | Явная область применимости, модель/провайдер/подписка, методика |
| `site/src/pages/commands.astro` | Короткая ссылка на workflows; справочник и поиск сохранить |
| `site/public/site.webmanifest` | Новая description |
| `site/public/og-image.png` | Полностью заменить старую карточку с Cheap DeepSeek |
| `site/package.json` | Добавить только `generate:og` script, без новых dependencies |
| `site/test/*.test.js`, `site/test/browser/site.spec.js` | Мигрировать затронутые проверки поведения |
| `site/scripts/check-lighthouse.mjs` | Добавить новые страницы в существующий coverage list |
| `docs/website/product-requirements.md` | Новый audience, goals, IA, acceptance |
| `docs/website/implementation-plan.md` | Указать новый активный план; сохранить действующую техническую архитектуру |
| `docs/website/README.md` | Ссылка на этот план и актуальное правило worktree |
| `docs/website/cloudflare-workers-deployment.md` | Новые маршруты в deploy acceptance |
| `README.md`, `CHANGELOG.md` | Кратко синхронизировать позиционирование/пользовательское изменение |

`site/src/data/pricing.js` и `site/public/scripts/pricing-cost.js` остаются источниками действующего калькулятора `/cost/`. Не менять формулы в рамках позиционирования. `site/src/data/commands.js` и `CommandCard.astro` остаются источником справочника, не превращать их в универсальный workflow CMS.

### Новые файлы

- `site/src/pages/workflows/index.astro`.
- `site/src/pages/workflows/research.astro`.
- `site/src/pages/workflows/review.astro`.
- `site/src/pages/workflows/implementation.astro`.
- `site/src/data/workflows.js`: только три карточки (`slug`, `title`, `description`, `href`, `cta`); homepage и каталог используют один массив.
- `site/src/data/delegation-example.json`: только реально полученный и проверенный public case study по контракту W02.
- `site/src/components/DelegationExample.astro`: build-time rendering примера на homepage и research page, prop `compact` для короткой формы.
- `site/public/scripts/home.js`: только copy-install enhancement, без калькулятора.
- `site/src/data/setup.js`: единственный источник текстов команд для статического рендера quickstart; никаких секретов или пользовательских настроек.
- `site/scripts/generate-og.mjs`: воспроизводимая генерация PNG из существующих локальных assets/fonts через уже имеющийся Chromium/Playwright; без новых пакетов.

Не добавлять прочие файлы без конкретной необходимости. Не создавать универсальный page builder, taxonomy, registry сценариев с dynamic routing, систему records/schema validation для одной истории.

### Ловушка старой главной

`pricing-index.js` обслуживает не только calculator:

- copy: `#copy-install-btn`, `#copy-label`;
- commands: `#cmd-list`, `#cmd-title`, `#cmd-note`, `#cmd-code`;
- install tabs: `.tab-btn[data-tab]`, `#install-code`;
- calculator: `#reqs-slider`, `#share-slider`, `#btn-sonnet`, `#btn-opus`, `#cost-without`, `#cost-with`, `#saved-line` и display labels;
- данные calculator берутся из JSON `#pricing-data`.

Не удалять скрипт, оставив пустые containers или необслуживаемую кнопку копирования. В новой главной команды/установка уже статические; старый script становится полностью ненужным после добавления `home.js`.

## 7. Пошаговые задачи

### W01 — Зафиксировать scope и подготовить источники

Зависимости: нет.

1. Убедиться, что текущая рабочая папка — этот worktree; прочитать разделы 1–6 и project instructions.
2. Прочитать `site/package.json`, `.github/workflows/site.yml`, `site/astro.config.mjs`, `site/src/layouts/Base.astro`.
3. Установить зависимости сайта командой `npm ci` с cwd `site/`. Не обновлять lockfile/dependencies ради редизайна.
4. Получить доступный Chromium через `npx playwright install chromium` с cwd `site/`; в Linux CI используется `--with-deps`.
5. Прочитать CLI syntax в `bin/triss.js` и `src/model-selection.js`, перечисленные canonical docs. Не принимать future/planned sections за работающие флаги.
6. Записать в рабочий отчёт версию Node/npm, версию Triss и commit для будущего примера. Не копировать environment или credential values.

Приёмка: известны источники, зависимости установлены; никаких новых runtime-функций или изменений чужого checkout.

### W02 — Получить реальный пример и проверить его

Зависимости: W01. Может ожидать доступ к настроенному провайдеру, пока остальные задачи выполняются.

Цель: не сочинённый terminal output, а небольшая публичная исследовательская задача. Только read-only команда, только публичный source. Не отправлять `.env`, локальные логи, всю рабочую папку или пользовательские материалы.

1. Источник примера — публичный репозиторий Triss на зафиксированном полном commit SHA; взять `src/model-selection.js` из этого commit. Если используете новый commit, убедиться, что он уже публичен, а не локальный неподнятый diff.
2. Не менять текущую конфигурацию пользователя ради примера. Использовать уже настроенный рабочий provider/engine; если конкретный маршрут пока не исполняется, честно зафиксировать препятствие, не подменять выбор автоматически.
3. Запустить реальную команду из корня checkout с этим исходником:

   ```sh
   triss ask --paths src/model-selection.js --question "How are provider, model, and execution engine selected? Cite the relevant lines and distinguish explicit request values from configured defaults."
   ```

4. Зафиксировать stdout, время/дату запуска, фактические provider/model/engine из доступного отчёта. Временные полные логи держать вне tracked content. Не включать их в сайт.
5. Вручную сверить каждый публикуемый вывод с исходником. Проверить отдельно provider precedence, role fallback, explicit engine/command default/configured engine. Не дописывать к ответу способности, которых нет в source.
6. Выбрать 2–3 коротких точных фрагмента реального ответа. Если сокращаете — назвать их `Excerpt from a recorded run`; не выдавать редакторский пересказ за дословный ответ.
7. Построить публичные source URLs с полным commit SHA и `#Lx-Ly`; вручную открыть ссылки.
8. Создать `site/src/data/delegation-example.json` с полями:
   - `recordedAt`: фактическая ISO дата;
   - `trissVersion`: фактическая версия;
   - `sourceCommit`: полный публичный SHA;
   - `provider`, `model`, `engine`: фактические идентификаторы, не guessed label;
   - `command`: фактически исполненная команда без shell prompt;
   - `question`: вопрос;
   - `findings`: массив `{ excerpt, sourceUrl, verification }`; verification — короткое редакторское объяснение проверки;
   - `limitations`: честные особенности именно этого case study.
9. Не добавлять token/cost/duration numbers к hero: для этой истории они не нужны. Если фактическая identity недоступна, разобраться в учёте или выбрать доступный реальный маршрут с разрешения пользователя, а не заполнить поля догадками.

Приёмка: реальный вызов выполнен; каждый excerpt соответствует output и source; ссылки открываются; нет ключей, абсолютных локальных путей, session IDs и фиктивных метрик.

**Если нет рабочего credential или сетевого доступа:** W02 пометить blocked с точной причиной; продолжить независимые задачи. Не подставлять mock/sample response, не публиковать `real example` и не считать итоговый сайт готовым. Это внешний prerequisite для финальной приёмки, не повод запускать платный сервис или заводить новый аккаунт самостоятельно.

### W03 — Добавить статические workflow metadata и общий пример

Зависимости: W01; final content `DelegationExample` зависит от W02.

1. Создать `workflows.js` по трём карточкам раздела 5. Экспорт `WORKFLOWS`; порядок research, review, implementation.
2. Создать `DelegationExample.astro`, импортирующий реальный JSON. Разметка: heading, source/date/model attribution, команда, findings со ссылками, короткая verification note, limitations.
3. Prop `compact=true` показывает короткую форму для hero; `compact=false` — подробный case study для research. Не создавать независимые копии результата.
4. На homepage wrapper имеет `id="delegation-example"`; на research другой уникальный id. Заголовки согласовать с h1/h2 страницы.
5. Astro escapes обычные строки. Не использовать `set:html` / `innerHTML` для ответа модели.
6. Findings показывать как текст, sourceUrl — обычная ссылка с описательным названием. Никакого исполнения Markdown/HTML из output.

Приёмка: пример читается без JS, attribution видима; компактный и полный вид используют один набор фактов; компонент не обращается к API в браузере.

### W04 — Переписать главную без старого pricing bundle

Зависимости: W03; до W02 можно выполнить layout, но нельзя выпускать фиктивный пример.

1. Переписать `index.astro` по порядку секций раздела 4 и точным текстам раздела 5.
2. Удалить pricing imports (`ANTHROPIC`, `DEEPSEEK`, `DEFAULTS`, `PROFILE`, `calcMonthly`), `_idx*` вычисления, calculator HTML и `#pricing-data`.
3. Удалить old commands preview и install tabs. Вместо preview — статические workflow cards + ссылка на `/commands/`; вместо трёх способов установки на главной — одна видимая npm-команда + Quickstart.
4. Сохранить anchors и существующий Header/Footer. MIT/npm/GitHub ссылки не терять.
5. Добавить `home.js` только для copy-install. Clipboard success показывать только после успешного `writeText`. При отказе — `Select and copy the command`; команда остаётся видимой и выделяемой.
6. Удалить `<script src="/scripts/pricing-index.js">` и сам `pricing-index.js`. Не оставлять compatibility stub.
7. Не трогать `pricing-cost.js`, `pricing.js` и DOM calculator на `/cost/`.
8. Внести scoped CSS новых секций в существующий `global.css`, сохранив tokens и focus/reduced-motion правила.

Приёмка: homepage без calculator/ошибок console; новый текст/пример/три сценария видны без JS; install можно скопировать или выделить; все старые оставленные anchors ведут к осмысленному контенту.

### W05 — Обновить общую навигацию и каталог сценариев

Зависимости: W03.

1. Обновить обе navigation lists в Header по разделу 4.
2. Сохранить `#main-nav`, `#mobile-nav`, mobile button, `aria-controls`, expanded state и существующий `mobile-menu.js`.
3. Добавить active states workflows/docs, использовать их на новых и существующих страницах.
4. Создать `/workflows/` через Base/Header/Footer и `WORKFLOWS`. H1: `Choose a task to delegate.`
5. Intro: `Start with a bounded question or change. These workflows show what to provide, what to inspect, and when to keep the work with your main agent.`
6. Под карточками кратко написать: `Triss can be called from your terminal or exposed to an agent through MCP. Your agent or you coordinate the steps; Triss does not automatically run a multi-agent pipeline.`
7. Footer менять только если добавление ссылок действительно нужно; существующие license/npm/releases links сохранить.

Приёмка: все пункты ведут на существующие страницы; текущая страница правильно выделена в обоих меню; mobile disclosure закрывается при переходе и сбрасывается при resize выше 900px.

### W06 — Написать research workflow

Зависимости: W02, W03, W05.

Файл: `site/src/pages/workflows/research.astro`.

H1: `Understand unfamiliar code without handing over the whole repository.`

Обязательные блоки:

1. **Use it when:** нужно ответить на конкретный вопрос по выбранным исходникам перед изменениями.
2. **Provide:** точный вопрос, выбранные файлы/quoted globs; секретные файлы не включать; directories не считать автоматическим recursive corpus.
3. **Run:** команда W02 и подпись, что это пример на исходниках Triss; в собственном репозитории пользователь выбирает свои пути. Не заставлять произвольный проект содержать `src/model-selection.js`.
4. **Inspect:** сверить ссылки и выводы с исходниками, определить неизвестное, сохранить необходимые детали для основного агента.
5. **Recorded example:** полный `DelegationExample`.
6. **Bring it back:** пример сообщения основному агенту, явно marked `Example instruction`: `Use these verified findings to plan the change. Re-open the relevant source before editing.`
7. **Limits:** это анализ переданного контекста, не доказательство полного понимания repository; модель может ошибаться; дополнительный запрос может быть нужен.
8. **Next:** Review workflow, Commands, Quickstart.

Приёмка: пользователь понимает вход/выход/верификацию; реальные результаты отделены от учебных инструкций; отсутствует обещание потери нулевого количества контекста.

### W07 — Написать review workflow

Зависимости: W05.

Файл: `site/src/pages/workflows/review.astro`.

H1: `Get a second review. Verify every finding.`

1. **Use it when:** нужно второе мнение о correctness defects, regressions и недостаточном покрытии изменения.
2. **Prerequisites:** выбранный провайдер настроен; локальная branch comparison требует Git/base ref; GitHub PR путь требует рабочий `gh` доступ согласно текущему CLI.
3. **Run:** локальный пример `triss review --base origin/main`. Явно указать: base должен существовать, команда относится к branch review, а не произвольным unstaged changes.
4. **Alternative source:** `git diff --cached | triss review --stdin` для staged diff. `triss review 123` — отдельно подписанный пример PR number, заменить номер своим; не запускать случайный PR в verification.
5. Не смешивать `--base`, PR input и `--stdin` в одной команде. Не копировать устаревший `--skip-issue` в новое руководство. Для issue context — только явный поддерживаемый `--issue`.
6. **Inspect:** для каждой находки проверить path/line, объяснение дефекта, достижимость, существующие guards/tests; отклонить неподтверждённые findings.
7. **Use the result:** основной агент/человек выбирает исправления; тестирует их; повторное review при необходимости — отдельное решение, не встроенная автоматическая цепочка.
8. **Limits:** не гарантия отсутствия дефектов, не автоматическое одобрение PR; partial/sharded result не выдавать за полный global verdict.
9. **Next:** Implementation workflow, Commands, Security.

Не публиковать выдуманные `src/auth.js:42` findings как реальные. Эта страница — исполнимый рецепт, не неподтверждённый case study.

Приёмка: все примеры соответствуют публичным CLI options; читатель понимает разницу источников и обязанности проверки.

### W08 — Написать implementation workflow до принятия/отказа

Зависимости: W05.

Файл: `site/src/pages/workflows/implementation.astro`.

H1: `Delegate a bounded change. Inspect it before it ships.`

1. **Prerequisites:** Git project, рабочий выбранный coding engine/provider, конкретные acceptance criteria. Ссылка на `/coder/` и setup; не выбирать за пользователя движок и не фиксировать одну модель.
2. **Define:** цель, разрешённая область изменений, команды проверок проекта, что не менять. Показать marked `Example task`, не fabricated execution transcript.
3. **Run:**

   ```sh
   triss coder run --isolate --session bounded-change "Implement the agreed change, keep unrelated files untouched, and run the focused checks specified in the task. Report the changes, checks, and remaining limitations."
   ```

4. Объяснить: естественный язык задаёт задачу, не создаёт новую sandbox policy. `--isolate` не OS sandbox; explicit protection requirements не заменять best effort молча.
5. **Locate the result:** читать фактический JSON envelope и доступную inventory (`triss coder result list`, `triss coder session list --engine opencode` — последняя команда отдельно отмечена примером для OpenCode; выбрать engine фактического запуска). Нельзя обещать retained artifact каждому успешному запуску: retention условна.
6. **Inspect the actual worktree:** подставить путь, сообщённый реальным запуском. Показать команды `git -C "$WORKTREE" status --short`, `git -C "$WORKTREE" diff --cached`, `git -C "$WORKTREE" diff`, `git -C "$WORKTREE" ls-files --others --exclude-standard`. Рядом объяснить, что `$WORKTREE` назначается фактическому пути перед выполнением, не копируется из demo.
7. Не ограничиваться `git diff`: Triss может stage deliverables. Проверить также untracked files, если они есть; diff-stat или files_changed не заменяет содержимое.
8. **Verify:** перейти в фактический worktree и выполнить настоящие focused checks из задачи. Не подменять выполнение проверок пересказом engine output. Наличие exit code 0 не означает правильность результата.
9. **Accept:** после проверки использовать обычный командный процесс Git (просмотр → осознанный commit/PR → review). Не заявлять автоматический merge, не показывать несуществующие `triss coder accept`, `result show`, `--expect`.
10. **Reject/cleanup:** не удалять непросмотренный diff. После явного решения удалить конкретный retained result через `triss coder result clean <run-id>` либо конкретную неактивную session через `triss coder session clean <slug> --engine <actual-engine>`. В тексте отметить, что `<...>` — заменяемые значения из реального inventory, это не готовые literals для copy button.
11. Развести result cleanup и session cleanup: первое не удаляет persistent session. `triss coder clean` удаляет finished no-diff worktrees, не является универсальным reject. Не советовать `--all` или `--recover-live` как обычный путь.
12. **Limits / Next:** execution/capability warnings, границы worktree, `/security/`, `/coder/`, полный reliable-delegation contract.

Приёмка: читатель может пройти запуск → найти изменения → проверить staged/unstaged/untracked → принять или осознанно удалить конкретный результат. Неизвестный/отсутствующий результат не обозначен как успешный.

### W09 — Перестроить quickstart без изменения runtime wizard

Зависимости: W01, W06. Файлы: getting-started.astro, getting-started.js, новый setup.js.

Сохранить пять шагов и anchors `#step-1`…`#step-5`, но убрать обязательное чтение advanced material между ними.

1. Верх страницы: H1 `Your first delegated task.`; кратко Node >=22.12 и credential для выбранного provider. Удалить обещания `20 seconds`, `30 seconds`, число зависимостей и фиктивное время npm install.
2. До шагов — выбор `Claude Code`, `Codex`, `Terminal`. Это выбор инструкции сайта, не изменение конфигурации пользователя и не заявление о наличии нового вопроса CLI wizard.
3. Шаги:
   - `Check Node`: `node --version`, объяснение минимальной версии без закреплённого demo patch release.
   - `Install Triss`: `npm install -g triss-coworker`; альтернативы pnpm/yarn/curl/source в необязательном раскрытии после primary command.
   - `Configure a provider`: `triss config wizard`; выбрать/сохранить свой provider, не показывать сочинённый пошаговый Easy transcript; `triss status` и объяснение готовности.
   - `Connect your agent`: соответствующая выбранному target инструкция ниже; если wizard уже подключил host — проверить, не требовать повторной настройки.
   - `Delegate a real task`: небольшая команда ask по явно существующим выбранным пользователем файлам, ссылка на runnable Triss-source case study. Не показывать выдуманные токены/стоимость для zai из тарифов DeepSeek.
4. Target commands:

   ```sh
   # Claude Code — explicit global setup
   triss mcp install --target claude --global
   triss init --target claude --global

   # Codex — explicit global setup
   triss mcp install --target codex --global
   triss init --target codex --global
   ```

   Объяснить scope, restart host session, `triss status`; не печатать guessed file writes. Для Codex можно указать `codex mcp list` после проверки текущего host CLI. Terminal: host setup не нужен, остаётся Triss CLI. Не писать CLAUDE.md/AGENTS.md пользователю, выбравшему Terminal.
5. Для шага 5 показать `triss ask --paths README.md --question "What does this project do, and which setup steps does its README require? Cite the relevant lines."`; явно применимо к проекту с README.md, иначе выбрать существующий текстовый файл. Это example input, не canned output.
6. В `setup.js` хранить только public command strings/labels по pm/target. В Astro вывести все панели статически. Public JS больше не хранит копии PM/AGENT строк и version outputs.
7. Progressive enhancement: без JS все подписанные варианты доступны; control groups скрыты до успешного JS init, panels не hidden на сервере. JS показывает selector buttons и скрывает неактивные panels; использует data attributes, `hidden`, `aria-pressed`, `textContent`; target по умолчанию Claude Code, переключение сохраняет package-manager selection/progress.
8. Если progress остаётся, это manual checklist, не проверка установки. Его кнопки/индикатор не должны создавать ложную интерактивность без JS. Не хранить выбор/прогресс в telemetry.
9. Ниже пяти шагов расположить обычные `<details>`: `Upgrading from older Triss versions`, `Advanced model and engine setup`, `Alternative installation methods`. Миграцию 0.42 не удалять; при anchor `#upgrade-042` раскрытие должно быть доступно (нативная ссылка/видимое summary).
10. Existing OpenCode 2 / OMP / OpenCode Go Muse setup не терять; переместить в Advanced, сохранить реальные версии/синтаксис и ссылки. Не вводить mandatory matrix/лишние подтверждения. Не называть пока отсутствующий Easy режим существующим CLI пунктом.

Приёмка: выбранный host имеет точные команды без лишней установки другого host; npm и первый ask доступны без JS; нет hard-coded `0.37.2`, фиктивных install outputs и model-independent денежных обещаний; optional blocks не прерывают основной маршрут.

### W10 — Согласовать вторичные страницы и ссылки

Зависимости: W06–W09.

**Docs:** `current="docs"`; первая группа Start here → quickstart/workflows; в Delegation три scenario links и Commands/Coder. Удалить `First release...not-yet-migrated` как главный текст, заменить `Guides, workflows, and reference documentation for working with Triss.`. Для внешних справочников label `GitHub documentation`. Исправить несуществующие README `#configure`, `#connect-your-agent`, `#what-it-does` на действующие разделы/прямые canonical docs. Не мигрировать весь docs corpus.

**Coder:** metadata из раздела 5; lead `Run bounded implementation tasks through your selected coding engine. Inspect the resulting changes before accepting them.`. В начале ссылка `Follow the implementation workflow`. Сохранить четыре engine selectors и companion Harness distinction; Harness не добавлять как CLI engine. Не закреплять один движок как единственно правильный. Проверить тексты `effective_isolation`/capabilities: current technical gaps описывать честно, без нового запрета best effort; не обещать enforced property всем routes. Не убирать реальные warnings. Краткий путь inspect/accept показать статически, не только в JS envelope tabs.

**Integrations:** lead из metadata плюс `Read context when you need it. Make external changes only through explicit operations.`. Перед interactive tabs статически вывести links на setup для пяти сервисов:

- Jira → `https://github.com/ayleen/triss-coworker/blob/main/docs/integrations/jira.md`.
- Confluence → `https://github.com/ayleen/triss-coworker/blob/main/docs/integrations/confluence.md`.
- Linear → `https://github.com/ayleen/triss-coworker/blob/main/docs/integrations/linear.md`.
- GitHub → `https://github.com/ayleen/triss-coworker/blob/main/docs/integrations/github.md`.
- GitLab → `https://github.com/ayleen/triss-coworker/blob/main/docs/integrations/gitlab.md`.

Для каждого: назначение, где настроить credential, как проверить готовность через `triss status`; не изобретать scopes. Read/search → inspect context → explicit create/update/comment — это решения пользователя/host, не автоматический ticket-to-code loop. Если примеры имеют shell continuation без `\`, исправить синтаксис. Не расширять в полный integration guide.

**Security:** перед вкладками статически ответить четырьмя пунктами: context goes to selected provider; local CLI has no developer telemetry; worktree is not host filesystem confinement; process success is not acceptance. Ссылка на `docs/data-flows.md` и provider retention/training/residency caveat: Triss не управляет политикой внешнего провайдера. Сохранить точное описание update check, logs, credentials и протекций; не заменять его лозунгом local/private.

**Cost:** оставить калькулятор на месте, формулы и historical week не менять. Выше результата добавить видимую область применимости: `This estimates API inference costs for the stated workload and pricing assumptions. It does not predict a reduction in a fixed-price Claude or Codex subscription.`. Уточнить, что текущий calculator использует Anthropic baseline и DeepSeek delegated pricing, не выбранный пользователем произвольный provider. Полностью неизвестные цены не интерпретировать как 0. Добавить `Triss is open-source software, not a hosted subscription. Model providers and execution services may charge separately.`. Historical $2.22 — стоимость записанного usage, не доказанная общая экономия/качество всех задач. Ссылки на methodology/usage accounting сохранить.

**Commands:** сохранить COMMANDS data, search, фильтры и примеры; в introductory copy добавить `Looking for an end-to-end task? Start with workflows.` со ссылкой. Не переписывать generated CLI reference.

Приёмка: никакой вторичный lead не возвращает весь продукт к обязательному cheap DeepSeek; пользователь находит сценарий, затем справочник и ограничения; действующие технические сведения не потеряны.

### W11 — Обновить metadata и social preview воспроизводимо

Зависимости: W04–W10.

1. Применить таблицу metadata, webmanifest description; проверить ровно один canonical/title/description/OG-set.
2. Сохранить `https://triss.work` на production и preview, автоматический sitemap и robots.
3. Текущий `og-image.png` содержит `Cheap DeepSeek Coworker for your coding agent`. Заменить её обязательно, не ограничиваться HTML metadata.
4. Новый PNG 1200×630: фон из текущего dark palette; существующий Triss mark; название Triss; основной текст `Managed delegation for AI development`; вторичная строка `Research. Review. Implement. Keep control.`. Не включать цены/модели/неподтверждённые проценты.
5. Добавить `site/scripts/generate-og.mjs`: генерировать из контролируемого локального HTML, local fonts/assets, с имеющимся Playwright Chromium; дождаться fonts/image readiness; сделать screenshot фиксированного viewport. Никаких remote embeds/fonts/new packages. Добавить npm script `generate:og` в `site/package.json`; lockfile не должен меняться, если dependencies не менялись.
6. Сохранить generated PNG как намеренный публичный asset; transient HTML/screenshots удалить после проверки. Не менять favicon/logo family.
7. Посмотреть PNG глазами и actual rendered metadata всех новых страниц. Путь `/og-image.png` в Base сохранить; не нужна новая per-page image API.

Приёмка: source script воспроизводит карточку; она читаема в 1200×630 и уменьшенном preview; старого cheap DeepSeek сообщения нет в image/metadata/manifest; новые URL присутствуют в sitemap.

### W12 — Мигрировать затронутые проверки

Зависимости: W04–W11. Не запускать общие проверки посреди одновременных правок.

1. Прочитать `site/test/build.test.js`, `consistency.test.js`, `interaction.test.js`, `quality.test.js`, `csp.test.js`, browser suite и site verification scripts.
2. Удалить только проверки obsolete homepage calculator/preview/install-tab behavior, если surface удалён. Calculator на `/cost/` продолжает проверяться.
3. Тест, который только ищет старый headline или exact prose, не перепривязывать к новому слогану. Заменять лишь если есть реальный observable contract; иначе удалить такую проверку.
4. Обновить существующие route inventories для четырёх `/workflows` routes; убедиться, что build/link/browser/Lighthouse coverage не продолжает проверять только старый набор.
5. Критичные browser contracts: new nav links, mobile state reset, copy success/failure, quickstart target switching, progressive enhancement without JS, workflow→reference navigation; существующие search safety, cost controls, engine controls, focus/touch/overflow и axe проверки сохранить.
6. Проверять структуру/поведение: корректный href/canonical, достижимый контент/команда, `aria-pressed`, clipboard отказ не сообщает success. Не assert полные тексты маркетинга, array lengths или тот факт, что функция вызвана.
7. Не писать test suite про content JSON wiring, имена классов и export forwarding. Новые permanent tests только на рискованные transitions/boundaries, не ради количества.
8. `site/scripts/check-links.mjs` проверяет локальные страницы/assets, но не доказывает корректность внешних GitHub anchors. Проверить изменённые внешние anchors отдельно вручную.
9. Не ослаблять CSP, accessibility targets или Lighthouse threshold, чтобы получить зелёный CI.

Точная карта текущих checks, чтобы не искать зависимости наугад:

| Файл / существующий test | Действие |
| --- | --- |
| `site/test/build.test.js` — `built site contains required entry points` | В existing pages list добавить `workflows`, `workflows/research`, `workflows/review`, `workflows/implementation`; проверять реальный `index.html`, не существование одной directory |
| `site/test/csp.test.js` — `pricing data islands are valid, self-contained JSON` | Убрать homepage из pricing loop, оставить Cost; выбирать island по `id="pricing-data"`, не первый попавшийся JSON script; валидность JSON/CSP сохранить, не тестировать декоративный порядок attributes |
| `site/test/consistency.test.js` — pricing source loop | Удалить source-regex, который требует exact JSON-island markup в index/cost; homepage больше не pricing consumer. Canonical pricing sync сохранить, а поведение Cost проверить на работающем calculator |
| `site/test/consistency.test.js` — `website documents persistent engine defaults for ask and review` | Не оставлять exact Muse/OpenCode/readonly prose как обязательное устройство продукта; удалить wording/source-text pins. Документированные optional setup commands сверить с CLI и вручную с W09; не писать новый regex на слово Easy |
| `site/test/consistency.test.js` — `website coder engines and quickstarts match repository contracts` | Сохранить meaningful compatibility facts; удалить точные предложения и source-layout assertions. Проверка обязательной конкретной версии OpenCode 2 не должна превращаться в runtime pin |
| `site/test/interaction.test.js` | Сохранить hostile-search behavior и сброс mobile disclosure; не менять menu JS path/IDs без необходимости |
| `site/test/browser/site.spec.js` — `routes` | Добавить все четыре новые slash-form routes; existing runtime-error/viewport/axe/focus/touch loops должны охватывать их |
| Browser: zoom/key routes | Добавить `/workflows/implementation/` и `/workflows/research/` к проверке 200% text zoom; сохранить Home/Commands/Quickstart |
| Browser: quickstart `.quickstart-steps`, `#step-3` | Сохранить работающий sticky/anchor контракт либо адаптировать к новой раскладке, не удалять coverage без причины |
| Browser: OMP keyboard/copy | Сохранить выбор движка, отображение команды и копирование; не перепривязывать exact narrative (`run-private config` и подобное). Проверить честность caveats редакторской приёмкой |
| `site/scripts/check-lighthouse.mjs` — `auditedRoutes` | Сохранить `/`, `/commands/`, `/docs/getting-started/`; добавить `/workflows/`, `/workflows/research/`, `/workflows/review/`, `/workflows/implementation/` с уникальными report names; threshold 0.9 для четырёх категорий не снижать |
| `site/test/quality.test.js` | Сохранить 50–180 chars descriptions, one h1, unique canonical/title, local resources, dimensions/alt, manifest/headers, total 2 MiB и JS 150 KiB; новый PNG <=350 KiB, HTML <=100 KiB/page |
| `site/scripts/check-links.mjs` | Route inventory здесь нет: scanner обходит build автоматически. Он не проверяет внешние anchors и может принять directory без index; build/browser checks закрывают эту дыру |

Не менять remote-resource/analytics tests: новая аналитика не входит в scope. Astro sitemap автоматически включает новые `.astro` routes; отдельный route manifest не создавать.

Приёмка: suite соответствует новому публичному поведению, не требует удалённого calculator на homepage и продолжает защищать calculator на Cost и остальные существующие controls.

### W13 — Проверить production build и пользовательские пути

Зависимости: W02–W12. Команды и ручная матрица — в разделе 8.

1. Остановить параллельные изменения. Запустить итоговые checks один раз последовательно по dependencies.
2. Поднять production build, открыть настоящий browser, проверить desktop/mobile/no-JS и изменённые transitions.
3. Проверить три сценария как читатель: landing → workflow → prerequisites → command → verification → next step. На implementation обязательно найти staged diff и cleanup explanations.
4. Отдельно проверить `/cost/` calculator, `/commands/` search и `/coder/` controls: они не должны сломаться от общих styles/nav.
5. Зафиксировать фактические команды/exit status и manual observations; screenshots локально/в CI artifacts, не коммитить их как часть source без конкретной цели.
6. Ошибки исправить в исходнике, повторить затронутую проверку; не подменять failure stub-output.

Приёмка: все gates раздела 8 пройдены или конкретно отмечены как внешне blocked. Любой blocked обязательный gate означает, что публикация ещё не готова.

### W14 — Согласовать документы и подготовить передачу

Зависимости: успешный smoke W13.

1. Обновить `docs/website/product-requirements.md`: primary audience, managed delegation goals, новую IA, вторичную роль экономии, реальные proof/limits и no-JS acceptance. Убрать старое обязательное `cheaper model` как определение продукта.
2. В `docs/website/implementation-plan.md` добавить в начало явную ссылку на этот активный план: прежние launch milestones — история, технический deployment contract сохраняется. Не оставлять два противоположных актуальных product briefs.
3. В `docs/website/README.md` сохранить ссылку на этот план, новый worktree convention; убрать устаревшие pending decisions про уже выбранный canonical domain. Не выдумывать решение о полном docs migration или новой аналитике.
4. В `docs/website/cloudflare-workers-deployment.md` добавить новые URL в acceptance list; production commands/domain/worker не менять.
5. В README кратко обновить вводное позиционирование и добавить ссылки на workflows. Не менять canonical command examples без контрактной причины.
6. В CHANGELOG под Unreleased добавить Changed про website positioning/workflow guides. Номер package version не повышать только ради сайта.
7. Удалить только свои временные source captures/generation files и obsolete homepage script. Не удалять чужие worktree/state/artifacts. Реальный sanitized example и OG PNG остаются намеренными assets.
8. Проверить изменённые links и docs consistency после финальных doc edits; выполнить полные root gates перед PR, если они требуются CONTRIBUTING/CI.
9. Передать владельцу: changed pages/files, browser evidence, точные проверки, remaining external blockers, краткий список того, что намеренно не менялось.
10. Commit/push/PR только после поручения. Каждый commit с DCO `git commit -s`. Preview по существующему non-production flow; production только после одобренного merge.

Приёмка: сайт и документы говорят об одном продукте; нет временных заглушек; не заявлено непроверенное внедрение; production не изменён без разрешения.

## 8. Проверки: команды и ожидаемые результаты

### 8.1 Среда

- Node >=22.12; для повторения CI использовать Node 24 и npm 11.6.2.
- cwd каждой команды ниже — `site/`, кроме отдельно обозначенных root checks.
- Нужен Chromium. Linux CI устанавливает `npx playwright install --with-deps chromium`; macOS — `npx playwright install chromium`.
- `site/playwright.config.mjs` запускает `node scripts/serve-dist.mjs --port 4876`, base URL `http://127.0.0.1:4876`; Lighthouse использует отдельный random localhost port.
- Dependency audit требует доступ к npm registry; preview/deploy требует Cloudflare доступ. Не объявлять их выполненными на основании локальной сборки.

### 8.2 Итоговые команды сайта

Выполнить после завершения edits:

```sh
npm run check
npm run lint
npm run build
npm run cloudflare:check
node scripts/check-links.mjs
npm test
npm run test:browser
npm run test:lighthouse
npm run audit:dependencies
```

Ожидается exit code 0 каждой команды. `cloudflare:check` — dry run, не production deploy. `npm run check` в `site/` — Astro check, не root all-project gate. `npm test` использует build output, поэтому build идёт раньше. Не запускать `npm run cloudflare:deploy` для локальной проверки.

Browser/Lighthouse используют существующие конфигурации и сервер production build. Не запускать вручную второй процесс на занятом порту. При работе инструментами агента долгоживущий server запускать через process manager (`hub start`), дождаться readiness, затем открыть browser; после работы остановить только свой процесс.

Для ручного просмотра допустим `npm run preview -- --host 127.0.0.1 --port 4321` с cwd `site/`, вне одновременного запуска Playwright-managed server. Для проверки истинного 404/headers использовать существующий static serve script/Cloudflare preview согласно текущим тестам, а не считать Astro dev server доказательством production headers.

Root acceptance перед PR, cwd корень worktree: установить root dependencies при необходимости и выполнить `npm run check` согласно CONTRIBUTING. Это не замена browser acceptance. Без runtime edits не нужно создавать новые root tests или запускать оплачиваемые model calls в CI.

### 8.3 Ручная браузерная матрица

| Поверхность | Действие | Ожидаемый результат |
| --- | --- | --- |
| Home desktop 1440px | Открыть первый экран | Headline, объяснение, CTA и реальный пример; нет калькулятора |
| Home 320/375/390px | Прокрутить сверху вниз | Нет page-level horizontal overflow, CTA до примера, readable text |
| Shared 768/900/1280px | Проверить навигацию/карточки | Нет обрезанных labels и наложений |
| Mobile menu | Открыть при 375px, resize >900px, вернуть 375px | Меню закрыто, expanded=false, focus/state корректны |
| Keyboard | Tab/Shift+Tab, Enter/Space на controls | Видимый focus, доступный порядок, нет ловушки |
| Text zoom | 200% на Home/Quickstart/workflow | Контент и controls не перекрываются, можно читать |
| Reduced motion | Включить настройку | Вся информация доступна без анимации |
| Copy install | Разрешить и запретить clipboard | Только успешная запись даёт success; отказ предлагает manual copy |
| No JavaScript | Home, Quickstart, все workflow routes | Есть тексты, команды, findings, source links; все варианты setup достижимы |
| Quickstart | Claude→Codex→Terminal, смена pm | Соответствующие инструкции; Terminal без обязательного host setup; выбранный pm не сброшен |
| Research | Открыть каждую source citation | Публичный commit, строки действительно подтверждают excerpt |
| Review | Проследовать ветке local/PR/stdin | Источники не смешаны; prerequisite и verification понятны |
| Implementation | Найти результат/проверки/cleanup | Нет обещания unconditional retention; staged и untracked учтены; cleanup targeted |
| Cost | Изменить sliders/model/cache controls | Результат меняется, assumptions видимы, нет JS errors |
| Commands | Поиск обычного и hostile HTML текста | Релевантные results; hostile input остаётся текстом, не DOM |
| Coder | Переключить четыре engines и copy | Controls работают; Harness не выдаётся за пятый engine |
| SEO/assets | Открыть все новые URLs и social PNG | Уникальные metadata, canonical triss.work, PNG читается |
| Unknown route | Открыть отсутствующий путь на production-like server | Custom 404 с HTTP 404, не 200 |

Automated axe/Lighthouse — часть evidence, не повод обещать WCAG certification без проверки. Сохранить исходные thresholds >=90 и реальные accessibility findings.

### 8.4 Проверка смысла перед сдачей

Вручную прочитать Home, Quickstart, Coder, Cost и social card подряд. На всех поверхностях один ответ: управляемое делегирование, выбранные инструменты, проверка результата; экономия не определяет весь продукт.

Поиск в затронутых public files по `cheap`, `expensive`, `proofreader`, `DeepSeek`, `cheapest`, `60%`, `0.37.2`, `intercepts` помогает найти старое содержание. Не удалять совпадения автоматически: DeepSeek на Cost/в фактическом примере допустим; security explanations и исторические цифры могут оставаться с контекстом.

Не утверждать, что новый headline повысил conversion. Предлагаемый отдельный продуктовый эксперимент после публикации: дать 5 целевым разработчикам без подсказки объяснить Triss и пройти первый сценарий; записать понимание/препятствия. Не добавлять tracking или выдуманные результаты исследования в этот PR.

## 9. Зависимости и распределение работы

Для одного недорогого исполнителя — последовательный порядок W01–W14. Независимые задачи можно продолжать при внешнем блокере W02; final acceptance W13 всё равно требует реальный пример.

Если владелец попросит параллельное исполнение, Main остаётся владельцем общих файлов и интеграции:

- Main: Header, global.css, homepage, metadata, общий data/components contract, проверки и документы.
- Исполнитель сценариев: только четыре `site/src/pages/workflows/*.astro`, после готового W03; не правит Header/global.css.
- Исполнитель quickstart: только getting-started.astro/js и setup.js; не правит другие страницы.
- Исполнитель вторичных страниц: только Coder/Integrations/Security/Cost/Commands и их собственные scripts; не меняет shared files.

Общие контракты фиксированы в этом документе; не договариваться о новых форматах в процессе. Каждый возвращает файлы, выполненные критерии и unresolved issues. Ни один не запускает project-wide checks во время параллельных edits. Main запускает их после интеграции один раз.

## 10. Итоговый checklist и формат отчёта

- [ ] W01: подготовлены источники и окружение.
- [ ] W02: получен и проверен реальный public example.
- [ ] W03: общие workflow metadata и example component.
- [ ] W04: новая главная, удалён старый homepage pricing bundle.
- [ ] W05: навигация и каталог сценариев.
- [ ] W06: законченный research workflow.
- [ ] W07: законченный review workflow.
- [ ] W08: implementation workflow до acceptance/targeted cleanup.
- [ ] W09: короткий progressive-enhancement quickstart.
- [ ] W10: согласованы вторичные страницы и reference links.
- [ ] W11: metadata, manifest, воспроизводимая social card.
- [ ] W12: мигрированы meaningful checks.
- [ ] W13: production build и браузерная acceptance пройдены.
- [ ] W14: документы согласованы, временные материалы убраны, передача готова.

Финальный отчёт исполнителя должен содержать:

1. Worktree/ветка и изменённые маршруты.
2. Ссылку на реальный case study с source commit и кратким результатом ручной проверки.
3. Проверки в формате `команда / cwd / exit status`; для browser — viewport/action/observed result.
4. Все внешние блокеры отдельно, без слова «готово» при незавершённом обязательном gate.
5. Что не менялось: runtime, provider choice, engine support policy, pricing formulas, telemetry и production deployment.
6. Commit/PR/preview URL только если соответствующее действие действительно выполнено по поручению.

Этот документ — полное задание на реализацию, не свидетельство, что описанный сайт или записанный пример уже существуют.
