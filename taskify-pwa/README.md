# Taskify PWA

Taskify is a zero-backend Progressive Web App for private task management, Cashu/Lightning bounties, and Nostr collaboration. The project is built with React, TypeScript, Tailwind, and Vite so it can be statically hosted while still delivering a rich offline-capable experience.

## Apple Intelligence + Shortcuts integration

The app now exposes its local task, board, and settings model to Apple’s on-device automation stack. This lets you wire up App Intents, Siri Shortcuts, Focus Mode automations, and the new Personal Context API without adding any paid infrastructure.

### Browser bridge (`window.taskifyAppleIntegration`)

When the PWA loads, it registers a bridge object on `window.taskifyAppleIntegration` with the following surface:

| Method | Description |
| --- | --- |
| `runIntent(intent)` | Performs an intent (`add-task`, `complete-task`, or `open-board`) using the live in-browser state. All operations run client-side and update the same localStorage stores (`taskify_tasks_v4`, `taskify_boards_v2`, `taskify_settings_v2`). |
| `getContextSnapshot()` | Returns a snapshot containing per-board summaries, upcoming tasks, and focus suggestions so Personal Context tiles or widgets can render “next action” cards without polling the DOM. |
| `listBoards()` | Lists visible boards, their column structure, and the storage keys that hold their data so Shortcuts/App Intents can make informed choices when suggesting targets. |

Example usage inside a Safari “Run JavaScript on Web Page” action or the Shortcuts app:

```js
const snapshot = window.taskifyAppleIntegration.getContextSnapshot();
completion(snapshot);
```

### URL intents for App Intents / Shortcuts

The main entry points also accept query parameters so you can trigger automations by opening a URL (from App Intents, Siri, Spotlight, Focus automations, etc.).

```
https://your-taskify-host.example/?ai-intent=add-task&title=Plan%20launch&board=Week&due=tomorrow&openBoard=1
```

Supported intents and parameters:

| Intent | Required params | Optional params |
| --- | --- | --- |
| `add-task` | `title` | `note`, `boardId`, `boardName`, `boardKind`, `columnId`, `column`, `due`, `weekday`, `openBoard`, `subtasks` (newline or `|` separated), `recurrence`, `streak`, `bounty` (JSON via `payload`), `hiddenUntil` |
| `complete-task` | `taskId` **or** `title` | `boardId`, `reopen` |
| `open-board` | — | `boardId`, `boardName`, `boardKind` |

You can also pass a JSON `payload` (plain or base64) with the same fields. After the intent executes, Taskify automatically cleans the query string so repeat visits don’t retrigger the automation.

### Focus Mode + Personal Context helpers

`getContextSnapshot()` returns:

- A `boards` array with each board’s outstanding count, summary (overdue/due today counts), and top five actionable tasks (including streaks, recurrence, and bounty state).
- A flattened `nextActions` list ideal for small widgets or Lock Screen cards.
- `focusSuggestions` with up to three recommended boards (e.g., today’s work board, the default week board, and any backlog with overdue items) so Focus automations can jump straight into the right context.

Because everything runs in the browser, Apple Intelligence and Shortcuts can keep working offline as long as the PWA is installed.

## React + TypeScript + Vite

This repo still uses the standard Vite tooling for development convenience.

Currently, two official plugins are available:

- [@vitejs/plugin-react](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react) uses [Babel](https://babeljs.io/) for Fast Refresh
- [@vitejs/plugin-react-swc](https://github.com/vitejs/vite-plugin-react/blob/main/packages/plugin-react-swc) uses [SWC](https://swc.rs/) for Fast Refresh

## Expanding the ESLint configuration

If you are developing a production application, we recommend updating the configuration to enable type-aware lint rules:

```js
export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...

      // Remove tseslint.configs.recommended and replace with this
      ...tseslint.configs.recommendedTypeChecked,
      // Alternatively, use this for stricter rules
      ...tseslint.configs.strictTypeChecked,
      // Optionally, add this for stylistic rules
      ...tseslint.configs.stylisticTypeChecked,

      // Other configs...
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```

You can also install [eslint-plugin-react-x](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-x) and [eslint-plugin-react-dom](https://github.com/Rel1cx/eslint-react/tree/main/packages/plugins/eslint-plugin-react-dom) for React-specific lint rules:

```js
// eslint.config.js
import reactX from 'eslint-plugin-react-x'
import reactDom from 'eslint-plugin-react-dom'

export default tseslint.config([
  globalIgnores(['dist']),
  {
    files: ['**/*.{ts,tsx}'],
    extends: [
      // Other configs...
      // Enable lint rules for React
      reactX.configs['recommended-typescript'],
      // Enable lint rules for React DOM
      reactDom.configs.recommended,
    ],
    languageOptions: {
      parserOptions: {
        project: ['./tsconfig.node.json', './tsconfig.app.json'],
        tsconfigRootDir: import.meta.dirname,
      },
      // other options...
    },
  },
])
```
