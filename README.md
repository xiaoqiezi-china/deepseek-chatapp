# DeepSeek Chat App

A chat client based on the DeepSeek official chat-demo, available for web, Windows desktop and Android. The interface follows the DeepSeek web app.

This project is not an official DeepSeek product. Chat, file upload and voice features call the official DeepSeek API directly with your own API key.

## Features

- Sessions: create, auto-title, rename, delete and group by date.
- Editing: edit a question or a reply and use the edited text as context for later messages; branch switching, regeneration and continuation.
- Replies: streaming output, reasoning, web search, link reading with citations, and text-to-speech.
- Attachments: upload, paste and drag images and files; voice input with a live waveform.
- Rendering: Markdown, syntax highlighting, KaTeX and Mermaid.
- Account: sign in with an API key, view balance and available models, and change the key.
- System prompt: use the default identity prompt or a custom one; an empty custom prompt omits the `system` field.
- Settings: Simplified Chinese / English, light / dark / system theme, TTS voice, location and model (defaults to `deepseek-flash`).
- History: ZIP import/export and delete-all.

## Run

Requires Node.js 22.12+ and pnpm.

```sh
pnpm install
pnpm dev
```

`pnpm dev` starts the web server on port 8090 and the local storage service on port 8091. Open http://localhost:8090 .

On Windows, run `stop.bat` to stop the servers, or press Ctrl+C in the terminal.

## Build

```sh
pnpm build          # static site in dist/
pnpm start          # single-origin mode: pages and storage API on port 8091
pnpm type           # TypeScript type check
pnpm lint           # lint
```

See [docs/build.md](docs/build.md) for desktop and APK builds.

## Data storage

On web, the local storage service writes to `data/` in the project root:

- `settings.json`: API key, UI settings, system prompt and model
- `summaries.json`: session summary index
- `sessions/<id>.json`: full session data
- `files/<id>`: attachment originals

Desktop and Android builds do not run the storage service. They write the same data structure into their own application data directories.

History import/export uses ZIP. Exports contain sessions and local image originals, excluding the API key, settings and non-image originals. Import replaces all sessions and attachments.

The API key is stored in plaintext in a local file. Do not use this app on a shared device, and never commit `data/` to a repository.

## Layout

```text
src/                 frontend UI and logic
  services/
    api/             DeepSeek API client, SSE and protocol types
    chat/            sessions, branching, storage adapters and history
    storage/         storage backend interface
server/              local storage service for web
src-tauri/           Tauri 2 desktop app
android/             Capacitor Android project
res/                 icon assets
```

## License

[MIT](LICENSE). Original work copyright DeepSeek. This project continues under the MIT license. Third-party dependencies keep their own licenses.
