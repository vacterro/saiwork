# CURRENTMARKHUNT — Полный аудит CodeNomad

> **Дата аудита**: 2026-08-09
> **Репо**: `V:\___VAC\__K\__CODE\_AI_STUFF_AGENTIC\_SAIWORK\CodeNomad`
> **Назначение**: Детальный список всех найденных нарушений AGENTS.md, архитектурных проблем, дублированного кода, стилистических ошибок. Агент-исполнитель ДОЛЖЕН прочитать этот файл целиком и последовательно чинить каждую секцию.

---

## ОГЛАВЛЕНИЕ

1. [AA-001: border-radius нарушения (КРИТИЧЕСКОЕ)](#aa-001)
2. [AA-002: Tailwind `rounded-*` классы в CSS (КРИТИЧЕСКОЕ)](#aa-002)
3. [AA-003: Aggregator-файлы содержат inline-стили (АРХИТЕКТУРНОЕ)](#aa-003)
4. [AA-004: Дублированные CSS-классы между aggregator и subfile](#aa-004)
5. [AA-005: Файлы-монолиты CSS (>150 строк)](#aa-005)
6. [AA-006: Файлы-монолиты TS/TSX (>500 строк)](#aa-006)
7. [AA-007: Тайпо "wintage" вместо "vintage"](#aa-007)
8. [AA-008: `!important` злоупотребление](#aa-008)
9. [AA-009: Hardcoded hex-цвета вместо CSS-токенов](#aa-009)
10. [AA-010: console.log в server production code](#aa-010)
11. [AA-011: index.css мусорные пустые строки](#aa-011)
12. [AA-012: cloudflare package не в workspaces](#aa-012)

---

<a name="aa-001"></a>
## AA-001: border-radius нарушения (КРИТИЧЕСКОЕ)

**Правило AGENTS.md строка 9**: _"Never use rounded corners in UI styling; keep corners square unless the user explicitly requests otherwise."_

### Что делать
Заменить ВСЕ ненулевые `border-radius` на `border-radius: 0` (или удалить свойство). Значения `border-radius: 0` и `border-radius: 0px` — ок, их НЕ трогать.

### Полный список нарушающих файлов и строк

#### `src/styles/components/directory-browser.css`
- **Строка 5**: `border-radius: var(--radius-xl);` → `border-radius: 0;`
- **Строка 136**: `border-radius: var(--radius-full);` → `border-radius: 0;`
- **Строка 175**: `border-radius: var(--radius-lg);` → `border-radius: 0;`

#### `src/styles/components/folder-drop.css`
- **Строка 22**: `border-radius: var(--radius-xl);` → `border-radius: 0;`

#### `src/styles/components/folder-home.css`
- **Строка 55**: `border-radius: 9999px;` → `border-radius: 0;`

#### `src/styles/components/folder-loading.css`
- **Строка 16**: `border-radius: var(--folder-card-radius);` → `border-radius: 0;`

#### `src/styles/components/permission-notification.css`
- **Строка 9**: `border-radius: 9999px;` → `0`
- **Строка 52**: `border-radius: var(--radius-xl);` → `0`
- **Строка 89**: `border-radius: 9999px;` → `0`
- **Строка 103**: `border-radius: var(--radius-sm);` → `0`
- **Строка 135**: `border-radius: var(--radius-lg);` → `0`
- **Строка 172**: `border-radius: 9999px;` → `0`
- **Строка 186**: `border-radius: var(--radius-sm);` → `0`

#### `src/styles/components/remote-access.css`
- **Строка 58**: `border-radius: 999px;` → `0`
- **Строка 75**: `border-radius: 12px;` → `0`
- **Строка 116**: `border-radius: 10px;` → `0`
- **Строка 139**: `border-radius: 12px;` → `0`
- **Строка 148**: `border-radius: 999px;` → `0`
- **Строка 171**: `border-radius: 999px;` → `0`
- **Строка 217**: `border-radius: 12px;` → `0`
- **Строка 252**: `border-radius: 999px;` → `0`
- **Строка 261**: `border-radius: 12px;` → `0`
- **Строка 315**: `border-radius: 10px;` → `0`
- **Строка 327**: `border-radius: 10px;` → `0`
- **Строка 335**: `border-radius: 10px;` → `0`

#### `src/styles/messaging/log-view.css`
- **Строка 60**: `border-radius: 12px;` → `0`
- **Строка 91**: `border-radius: 9999px;` → `0`

#### `src/styles/messaging/message-base.css`
- **Строка 116**: `border-radius: 0.25rem;` → `0`
- **Строка 284**: `border-radius: 10px;` → `0`
- **Строка 294**: `border-radius: 8px;` → `0`
- **Строка 333**: `border-radius: 4px;` → `0`
- **Строка 342**: `border-radius: 4px;` → `0`
- **Строка 638**: `border-radius: 0.375rem;` → `0`

#### `src/styles/messaging/message-section.css`
- **Строка 251**: `border-radius: 9999px;` → `0`
- **Строка 290**: `border-radius: 9999px;` → `0`
- **Строка 385**: `border-radius: 0.75rem;` → `0`
- **Строка 393**: `border-radius: 0.2em;` → `0`

#### `src/styles/messaging/message-selection.css`
- **Строка 16**: `border-radius: 12px;` → `0`
- **Строка 43**: `border-radius: 999px;` → `0`
- **Строка 86**: `border-radius: 10px;` → `0`
- **Строка 157**: `border-radius: 999px;` → `0`
- **Строка 196**: `border-radius: 6px;` → `0`

#### `src/styles/messaging/message-timeline.css`
- **Строка 73**: `border-radius: 8px;` → `0`
- **Строка 88**: `border-radius: 9999px;` → `0`
- **Строка 275**: `border-radius: 8px;` → `0`
- **Строка 389**: `border-radius: 999px;` → `0`
- **Строка 438**: `border-radius: 2px;` → `0`

#### `src/styles/messaging/prompt-input.css`
- **Строка 28**: `border-radius: 1px;` → `0`
- **Строка 315**: `border-radius: 0.375rem;` → `0`
- **Строка 412**: `border-radius: 3px;` → `0`
- **Строка 434**: `border-radius: 10px;` → `0`
- **Строка 443**: `border-radius: 8px;` → `0`

#### `src/styles/messaging/tool-call/todo.css`
- **Строка 34**: `border-radius: var(--radius-full);` → `0`
- **Строка 80**: `border-radius: var(--radius-full);` → `0`
- **Строка 114**: `border-radius: var(--radius-full);` → `0`

#### `src/styles/messaging/tool-call.css`
- **Строка 31**: `border-radius: 0.375rem;` → `0`
- **Строка 78**: `border-radius: 3px;` → `0`
- **Строка 144**: `border-radius: 0.25rem;` → `0`
- **Строка 500**: `border-radius: 0.25rem;` → `0`
- **Строка 582**: `border-radius: 0.375rem;` → `0`
- **Строка 594**: `border-radius: 0.5rem;` → `0`
- **Строка 613**: `border-radius: 0.5rem;` → `0`
- **Строка 658**: `border-radius: 0.5rem;` → `0`
- **Строка 813**: `border-radius: 0.25rem;` → `0`
- **Строка 881**: `border-radius: 4px;` → `0`
- **Строка 955**: `border-radius: var(--radius-sm);` → `0`
- **Строка 1004**: `border-radius: var(--pill-radius);` → `0`
- **Строка 1137**: `border-radius: 4px;` → `0`

#### `src/styles/panels/empty-loading.css`
- **Строка 52**: `border-radius: 3px;` → `0`

#### `src/styles/panels/right-panel.css`
- **Строка 45**: `border-radius: 8px 8px 0 0;` → `0`
- **Строка 457**: `border-radius: 999px;` → `0`
- **Строка 508**: `border-radius: 999px;` → `0`

#### `src/styles/panels/session-layout.css`
- **Строка 323**: `border-radius: 0.75rem;` → `0`
- **Строка 715**: `border-radius: 9999px;` → `0`

#### `src/styles/markdown.css`
- **Строка 141**: `border-radius: 4px;` → `0`
- **Строка 158**: `border-radius: 8px;` → `0`

#### `src/styles/messaging.css` (aggregator — inline styles, также AA-003)
- **Строка 74**: `border-radius: 4px;` → `0`
- **Строка 83**: `border-radius: 4px;` → `0`

#### `src/styles/panels.css` (aggregator — inline styles, также AA-003)
- **Строка 258**: `border-radius: 9999px;` → `0`
- **Строка 319**: `border-radius: 3px;` → `0`

**ВАЖНО**: Некоторые `border-radius: 0` и `border-radius: 0px` уже правильны — это исправления, которые были когда-то применены. НЕ ТРОГАТЬ ИХ. Менять только ненулевые значения.

---

<a name="aa-002"></a>
## AA-002: Tailwind `rounded-*` классы в CSS (КРИТИЧЕСКОЕ)

В `@apply` директивах CSS используются Tailwind-классы `rounded`, `rounded-lg`, `rounded-md`, `rounded-full`, `rounded-t-md`. Все эти классы добавляют border-radius, что нарушает правило "no rounded corners".

### Что делать
Убрать `rounded`, `rounded-lg`, `rounded-md`, `rounded-full`, `rounded-t-md` из всех `@apply` директив в CSS-файлах. Не добавлять замену — просто удалить слово из строки.

### Файлы и строки

| Файл | Строка | Класс |
|------|--------|-------|
| `components/badges.css` | 3 | `rounded` |
| `components/badges.css` | 9 | `rounded` |
| `components/buttons.css` | 4 | `rounded-lg` |
| `components/buttons.css` | 23 | `rounded-lg` |
| `components/buttons.css` | 41 | `rounded-lg` |
| `components/buttons.css` | 60 | `rounded-lg` |
| `components/dropdown.css` | 3 | `rounded-md` |
| `components/dropdown.css` | 60 | `rounded` |
| `components/selector.css` | 3 | `rounded` |
| `components/selector.css` | 66 | `rounded-md` |
| `components/selector.css` | 78 | `rounded` |
| `components/selector.css` | 99 | `rounded` |
| `components/selector.css` | 140 | `rounded` |
| `components/selector.css` | 160 | `rounded` |
| `components/selector.css` | 187 | `rounded` |
| `components/selector.css` | 230 | `rounded` |
| `components/selector.css` | 246 | `rounded` |
| `components/selector.css` | 270 | `rounded` |
| `components/selector.css` | 286 | `rounded` |
| `messaging.css` | 24 | `rounded` |
| `messaging.css` | 31 | `rounded` |
| `messaging.css` | 88 | `rounded` |
| `messaging/log-view.css` | 20 | `rounded` |
| `messaging/message-base.css` | 227 | `rounded-full` |
| `messaging/message-base.css` | 250 | `rounded` |
| `messaging/message-base.css` | 256 | `rounded` |
| `messaging/message-base.css` | 346 | `rounded` |
| `messaging/message-section.css` | 53 | `rounded-md` |
| `messaging/message-section.css` | 81 | `rounded-full` |
| `messaging/message-section.css` | 127 | `rounded-md` |
| `messaging/message-section.css` | 356 | `rounded-md` |
| `messaging/prompt-input.css` | 181 | `rounded-md` |
| `messaging/prompt-input.css` | 273 | `rounded-md` |
| `messaging/prompt-input.css` | 279 | `rounded-md` |
| `messaging/prompt-input.css` | 365 | `rounded-md` |
| `messaging/prompt-input.css` | 409 | `rounded` |
| `messaging/prompt-input.css` | 454 | `rounded` |
| `messaging/tool-call.css` | 517 | `rounded` |
| `messaging/tool-call.css` | 1090 | `rounded` |
| `panels.css` | 23 | `rounded-t-md` |
| `panels.css` | 59 | `rounded` |
| `panels.css` | 69 | `rounded-md` |
| `panels.css` | 86 | `rounded-t-md` |
| `panels.css` | 167 | `rounded-full` |
| `panels.css` | 330 | `rounded-full` |
| `panels.css` | 343 | `rounded-lg` |
| `panels.css` | 409 | `rounded-lg` |
| `panels/empty-loading.css` | 62 | `rounded-full` |
| `panels/modal.css` | 8 | `rounded-lg` |
| `panels/panel-shell.css` | 3 | `rounded-lg` |

**Примечание**: `.spinner` и `.status-dot` используют `rounded-full` для создания кружков (spinner animation, status dots). Для этих КОНКРЕТНЫХ случаев `rounded-full` можно оставить, но ТОЛЬКО для элементов, которые должны быть круглыми по функциональному назначению (индикаторы статуса, спиннеры). Всё остальное — убрать.

**Исключения (НЕ трогать)**:
- `.spinner` (`panels.css:330`, `panels/empty-loading.css:62`) — нужен для анимации вращения
- `.status-dot` (`panels.css:167`, `messaging/message-section.css:81`) — круглый индикатор статуса

---

<a name="aa-003"></a>
## AA-003: Aggregator-файлы содержат inline-стили (АРХИТЕКТУРНОЕ)

**Правило AGENTS.md строка 5**: _"Keep aggregate entry files (e.g., `src/styles/controls.css`, `messaging.css`, `panels.css`) lean—they should only `@import` feature-specific subfiles."_

### Проблема
`messaging.css` и `panels.css` — это aggregator-файлы, которые должны содержать ТОЛЬКО `@import` строки. Но оба содержат сотни строк inline CSS-стилей.

### `messaging.css` (115 строк, должно быть ~10)
- Строки 1–9: `@import` — ✅ правильно
- Строки 11–115: inline CSS-стили — ❌ нарушение

Эти классы определены inline: `.message-item-base`, `.assistant-message`, `.message-queued-badge`, `.message-error-block`, `.message-generating`, `.message-sending`, `.message-error`, `.generating-spinner`, `.message-text`, `.message-text-assistant`, `.message-text pre`, `.message-error-part`, `.message-reasoning`, `.reasoning-container`, `.reasoning-header`, `.reasoning-icon`, `.reasoning-label`.

### `panels.css` (529 строк, должно быть ~8)
- Строки 1–7: `@import` — ✅ правильно
- Строки 9–529: inline CSS-стили — ❌ нарушение

Эти классы определены inline: `.tab-bar-*`, `.tab-*`, `.new-tab-button`, `.session-tab-*`, `.connection-status-*`, `.sidebar-selector*`, `.status-indicator*`, `.empty-state*`, `.loading-state`, `.spinner`, `.modal-*`, `.panel-*`.

### Что делать
1. Вынести inline-стили из `messaging.css` в новый файл `messaging/messaging-base-inline.css` (или распределить по существующим subfiles).
2. Вынести inline-стили из `panels.css` в новые файлы:
   - `panels/status-indicators.css` — для `.status-indicator*`
   - `panels/tab-bars.css` — если ещё нет в `panels/tabs.css`
   - `panels/empty-states.css` — для `.empty-state*`, `.loading-state`
   - Или распределить по существующим `panels/modal.css`, `panels/panel-shell.css`, `panels/tabs.css`
3. Оставить в aggregator-файлах ТОЛЬКО `@import` строки.

**ВАЖНО**: Проверить, что стили из `panels.css` inline уже не дублируют `panels/modal.css`, `panels/panel-shell.css`, `panels/tabs.css` (см. AA-004).

---

<a name="aa-004"></a>
## AA-004: Дублированные CSS-классы между aggregator и subfile

### Обнаруженные дубликаты

| Класс | Файл 1 (aggregator) | Файл 2 (subfile) |
|-------|---------------------|-------------------|
| `.message-queued-badge` | `messaging.css:23` | `messaging/message-base.css:249` |
| `.message-error-block` | `messaging.css:30` | `messaging/message-base.css:255` |
| `.modal-surface` | `panels.css:342` | `panels/modal.css:7` |
| `.panel` | `panels.css:408` | `panels/panel-shell.css:2` |

### Что делать
1. Удалить дублирующиеся определения из aggregator-файлов (`messaging.css`, `panels.css`).
2. Оставить определения только в subfile-ах (`message-base.css`, `modal.css`, `panel-shell.css`).
3. Проверить, что после удаления стили не ломаются (порядок @import может влиять на каскад).

### Как проверять
- Поискать все CSS-классы из `messaging.css` (строки 11+) в файлах `messaging/*.css`. Если класс найден в обоих местах — удалить из `messaging.css`.
- Аналогично для `panels.css` (строки 9+) в `panels/*.css`.

---

<a name="aa-005"></a>
## AA-005: Файлы-монолиты CSS (>150 строк)

**Правило AGENTS.md строка 7**: _"Prefer smaller, focused style files (≈150 lines or less) over large monoliths."_

### Файлы, превышающие порог

| Файл | Примерный размер (bytes) | Оценка строк | Действие |
|------|--------------------------|--------------|----------|
| `messaging/tool-call.css` | 29,524 | ~700+ | РАЗБИТЬ: split по tool-type (diff, shell, file, browser, etc.) |
| `panels/right-panel.css` | 23,761 | ~550+ | РАЗБИТЬ: session-list, info-panel, browser-frame |
| `components/settings-screen.css` | 20,200 | ~450+ | РАЗБИТЬ: settings-nav, settings-card, settings-toggle, media-queries |
| `panels/session-layout.css` | 17,645 | ~400+ | РАЗБИТЬ: sidebar, session-pane, connection-status |
| `messaging/message-base.css` | 16,640 | ~380+ | РАЗБИТЬ: message-text, message-badges, message-reasoning |
| `vintage-golden.css` | 15,319 | ~350+ | Допустимо (дизайн-система), но можно разбить на sections |
| `messaging/message-timeline.css` | 13,378 | ~300+ | РАЗБИТЬ: timeline-segments, timeline-items, timeline-badges |
| `messaging/prompt-input.css` | 13,289 | ~300+ | РАЗБИТЬ: input-area, action-buttons, attachment-chips |
| `panels.css` (aggregator)| 12,702 | ~530 | ВЫНЕСТИ inline-стили (см. AA-003) |
| `messaging/message-section.css` | 9,760 | ~220+ | Допустимо |
| `wintage-themes.css` | 9,459 | ~200+ | Допустимо (theme definitions) |
| `components/provider-auth.css` | 8,857 | ~200+ | Допустимо |
| `markdown.css` | 8,139 | ~180+ | Допустимо, но можно разбить |
| `components/selector.css` | 7,529 | ~170+ | Допустимо |
| `panels/tabs.css` | 6,884 | ~160+ | Допустимо |
| `components/remote-access.css` | 6,749 | ~155+ | Допустимо |

### Приоритет
1. `tool-call.css` — самый большой (700+ строк), разбить ПЕРВЫМ
2. `right-panel.css` — 550+ строк
3. `settings-screen.css` — 450+ строк
4. `session-layout.css` — 400+ строк

---

<a name="aa-006"></a>
## AA-006: Файлы-монолиты TS/TSX (>500 строк)

**Правило AGENTS.md строки 40-41**: _"Source files: warn after ~500 lines; target limit ~800 lines."_

### Файлы, значительно превышающие порог (по размеру в байтах → оценка строк)

| Файл | Размер | Оценка строк | Категория |
|------|--------|--------------|-----------|
| `components/message-section.tsx` | 75,863 B | ~2000+ | 🔴 CRITICAL |
| `stores/instances.ts` | 73,820 B | ~1800+ | 🔴 CRITICAL |
| `components/message-block.tsx` | 70,103 B | ~1700+ | 🔴 CRITICAL |
| `stores/preferences.tsx` | 53,216 B | ~1300+ | 🔴 CRITICAL |
| `stores/session-api.ts` | 53,590 B | ~1300+ | 🔴 CRITICAL |
| `components/folder-selection-view.tsx` | 51,109 B | ~1300+ | 🔴 CRITICAL |
| `stores/session-state.ts` | 46,649 B | ~1100+ | 🟡 MAJOR |
| `components/prompt-input.tsx` | 45,679 B | ~1100+ | 🟡 MAJOR |
| `components/message-timeline.tsx` | 45,198 B | ~1100+ | 🟡 MAJOR |
| `components/tool-call.tsx` | 42,879 B | ~1050+ | 🟡 MAJOR |
| `components/session-list.tsx` | 37,550 B | ~900+ | 🟡 MAJOR |
| `App.tsx` | 32,328 B | ~800+ | 🟡 WARNING |
| `components/virtual-follow-list.tsx` | 32,564 B | ~800+ | 🟡 WARNING |
| `stores/session-events.ts` | 27,726 B | ~700+ | 🟡 WARNING |
| `lib/api-client.ts` | 25,383 B | ~600+ | ⚪ WARN |
| `components/worktree-selector.tsx` | 25,685 B | ~600+ | ⚪ WARN |
| `components/remote-access-overlay.tsx` | 25,456 B | ~600+ | ⚪ WARN |
| `components/unified-picker.tsx` | 23,811 B | ~550+ | ⚪ WARN |
| `components/permission-approval-modal.tsx` | 20,282 B | ~500+ | ⚪ WARN |
| `lib/markdown.ts` | 20,389 B | ~500+ | ⚪ WARN |
| `components/directory-browser-dialog.tsx` | 19,936 B | ~500+ | ⚪ WARN |

Серверные:
| Файл | Размер | Оценка строк |
|------|--------|--------------|
| `server/http-server.ts` | 50,860 B | ~1200+ | 🔴 CRITICAL |
| `index.ts` | 26,375 B | ~676 (точно) | 🟡 WARNING |
| `server/remote-proxy.ts` | 20,879 B | ~500+ | ⚪ WARN |

### Действие
НЕ рефакторить только ради порога. Но УПОМИНАТЬ в ответе, что файл превышает лимит, когда его трогаешь. Для `message-section.tsx` (2000+ строк) и `instances.ts` (1800+ строк) — ситуация действительно критическая и стоит отметить в BOARD.md для будущего рефакторинга.

---

<a name="aa-007"></a>
## AA-007: Тайпо "wintage" вместо "vintage"

### Описание
Файл `wintage-themes.css` и связанный TypeScript `wintage-themes.ts` содержат тайпо. Правильное написание: "vintage" (в проекте уже есть `vintage-golden.css`).

### Затронутые файлы
1. `src/styles/wintage-themes.css` — ФАЙЛ (должен быть `vintage-themes.css`)
2. `src/lib/wintage-themes.ts` — ФАЙЛ (должен быть `vintage-themes.ts`)
3. `src/main.tsx:12` — `import "./styles/wintage-themes.css"` → `"./styles/vintage-themes.css"`
4. `src/components/theme-mode-toggle.tsx:6` — `import { wintageThemes } from "../lib/wintage-themes"` → `"../lib/vintage-themes"`, переименовать export
5. `src/lib/theme.tsx:5` — `import { wintageThemes } from "./wintage-themes"` → `"./vintage-themes"`
6. `src/styles/vintage-golden.css:21` — комментарий `/* Colors are now provided dynamically by wintage-themes.css */` → `vintage-themes.css`
7. `src/lib/wintage-themes.ts:6` — `export const wintageThemes` → `export const vintageThemes`

### Что делать
1. Переименовать файлы: `wintage-themes.css` → `vintage-themes.css`, `wintage-themes.ts` → `vintage-themes.ts`
2. Обновить ВСЕ импорты (пути 3-5 выше)
3. Переименовать экспорт `wintageThemes` → `vintageThemes` и обновить все использования (в `theme-mode-toggle.tsx` и `theme.tsx`)
4. Обновить комментарий (путь 6)
5. `git mv` для сохранения истории

### ВНИМАНИЕ
Это rename — тестировать после изменения, чтобы ничего не сломалось. Лучше делать через `git mv` + bulk find-replace.

---

<a name="aa-008"></a>
## AA-008: `!important` злоупотребление

### Описание
Найдено **100+** использований `!important` в CSS-файлах. `!important` — антипаттерн, указывающий на проблемы со специфичностью каскада или на борьбу с Tailwind. В правильно организованном CSS `!important` нужен крайне редко.

### Файлы с наибольшим количеством `!important`

| Файл | Кол-во `!important` |
|------|---------------------|
| `messaging/message-timeline.css` | ~30+ |
| `messaging/tool-call.css` | ~20+ |
| `components/settings-screen.css` | ~15+ |
| `markdown.css` | ~10 |
| `vintage-golden.css` | ~5 |
| `components/folder-home.css` | 2 |
| `components/selector.css` | 3 |
| `panels/right-panel.css` | ~10+ |
| `panels/session-layout.css` | ~5+ |

### Что делать
**НЕ чинить массово** — это потенциально опасный рефактор, который может сломать каскад. Но ОТМЕТИТЬ в BOARD.md как tech debt для будущей работы. Каждый раз, когда трогаешь файл с `!important`, попробовать убрать 1-2 из них, повысив специфичность селектора вместо этого.

### Конкретные safe-to-fix случаи
- `vintage-golden.css:222` — `border-radius: 0 !important;` → убрать `!important`, это и так последнее определение
- `markdown.css:315,319` — `border-radius: 0 !important;` → аналогично

---

<a name="aa-009"></a>
## AA-009: Hardcoded hex-цвета вместо CSS-токенов

**Правило AGENTS.md строка 4**: _"Reuse the existing token & utility layers before introducing new CSS variables."_

### Файлы с hardcoded hex

| Файл | Строки | Цвета |
|------|--------|-------|
| `messaging/message-section.css` | 394-403 | `#fde047`, `#eab308`, `#facc15`, `#ca8a04`, `#111827` |
| `messaging/message-timeline.css` | 444-456 | `#eab308`, `#fde047`, `#111827`, `#facc15`, `#ca8a04` |
| `messaging/prompt-input.css` | 275,298,303,308 | `#ffffff` (fallback — допустимо) |
| `messaging/tool-call/todo.css` | 122 | `#ffffff` (fallback — допустимо) |
| `components/remote-access.css` | 333-334 | `#e65c5c` (fallback — допустимо) |
| `components/settings-screen.css` | 396-397 | `#e65c5c` (fallback — допустимо) |
| `components/toast-history.css` | 112-169 | `#0ea5e9`, `#10b981`, `#f59e0b`, `#ef4444` (fallbacks — допустимо) |

### Что делать
- **message-section.css** и **message-timeline.css**: Жёлтые hex-цвета (`#fde047`, `#eab308`, `#facc15`, `#ca8a04`, `#111827`) — это скорее всего saipen goal highlight. Нужно вынести в токены (`tokens.css`), например: `--saipen-highlight-bg`, `--saipen-highlight-border`, `--saipen-highlight-text`.
- Fallback-hex (с `var(--xxx, #hex)`) — ДОПУСТИМЫ, не трогать.

---

<a name="aa-010"></a>
## AA-010: console.log в server production code

### Файлы

| Файл | Строки | Контекст |
|------|--------|----------|
| `server/src/cli-upgrade.ts` | 47 | Upgrade command output — допустимо для CLI |
| `server/src/index.ts` | 353, 614, 616, 622, 624 | Bootstrap token & server URLs — допустимо для CLI startup |
| `server/src/launcher.ts` | 17-18 | Browser launch debug — ДОЛЖЕН использовать logger |
| `server/src/shutdown.ts` | 20 | Default reportStatus — допустимо |

### Что делать
- `launcher.ts:17-18` — заменить `console.log` на `logger.info()` (в файле уже есть `createLogger` в других местах проекта)
- Остальные — CLI output, допустимо оставить

---

<a name="aa-011"></a>
## AA-011: index.css мусорные пустые строки

### Файл: `packages/ui/src/index.css`
Файл содержит 65 строк, из которых строки 36-64 — это ~30 пустых строк. Мусор.

### Что делать
Удалить все пустые строки после строки 34 (тело `#root`). Оставить одну пустую строку в конце файла.

---

<a name="aa-012"></a>
## AA-012: cloudflare package не в workspaces

### Проблема
В корневом `package.json` (строки 8-14) в `workspaces.packages` перечислены:
- `packages/server` ✅
- `packages/ui` ✅
- `packages/electron-app` ✅
- `packages/tauri-app` ✅
- `packages/opencode-plugin` ✅

НО `packages/cloudflare` — существует как директория с собственным `package.json`, но НЕ включён в workspaces.

### Что делать
- Если `packages/cloudflare` — часть монорепо и должен участвовать в `npm install` / `npm workspaces` — добавить `"packages/cloudflare"` в массив `workspaces.packages`.
- Если `packages/cloudflare` — standalone package с отдельным `package-lock.json` (что подтверждается наличием собственного `package-lock.json` на 50KB) — допустимо, но стоит документировать это решение.
- **Решение**: проверить, есть ли cross-dependencies между cloudflare и другими packages. Если нет — оставить standalone. Если есть — добавить в workspaces и удалить его собственный `package-lock.json`.

---

## ПОРЯДОК ИСПРАВЛЕНИЙ (рекомендуемый)

1. **AA-011** (index.css пустые строки) — 30 секунд, безопасно
2. **AA-007** (wintage → vintage rename) — 5 минут, требует `git mv`
3. **AA-004** (дубликаты CSS-классов) — 10 минут, удаление из aggregators
4. **AA-003** (вынос inline-стилей из aggregators) — 30 минут, создание новых файлов
5. **AA-001** + **AA-002** (border-radius fixes) — 45 минут, массовая замена
6. **AA-010** (console.log → logger) — 5 минут
7. **AA-009** (hardcoded hex → tokens) — 15 минут
8. **AA-008** (!important) — отметить в BOARD, чинить постепенно
9. **AA-005** + **AA-006** (файлы-монолиты) — отметить в BOARD, чинить при касании

---

## ПРОВЕРКА ПОСЛЕ ИСПРАВЛЕНИЙ

```bash
# 1. Typecheck
npm run typecheck

# 2. Тесты
npm run test

# 3. Визуальная проверка — запустить dev-сервер
npm run dev

# 4. Проверить, что border-radius нигде не осталось (кроме 0 и исключений)
findstr /S /R "border-radius" packages\ui\src\styles\*.css | findstr /V "border-radius: 0"

# 5. Проверить, что rounded классы убраны
findstr /S "rounded" packages\ui\src\styles\*.css | findstr /V "rounded-full" | findstr /V "spinner\|status-dot"
```

---

## КОНТЕКСТ ДЛЯ АГЕНТА

- Репо — монорепо Node.js с npm workspaces
- UI: SolidJS + Vite + Tailwind 3
- Server: Fastify + TypeScript (ESM)
- Desktop: Electron + Tauri (два варианта)
- Стилизация: tokens.css (дизайн-система) → utilities.css → component CSS files
- Aggregator pattern: `controls.css`, `messaging.css`, `panels.css` должны содержать ТОЛЬКО `@import`
- i18n: custom layer, NOT ICU. API: `useI18n()` + `tGlobal()`
- Vintage/Golden theme: dark golden Win95 aesthetic (UI.md)
- **Ключевое правило**: NO ROUNDED CORNERS. Всё квадратное.
