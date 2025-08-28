## Journal Visualizer (tldraw + Gemini)

An MVP for auto-generating images as you write, using a tldraw canvas as the primary surface and Google Gemini 2.5 Flash Image Preview for image generation.

### Quick Start

1) Install dependencies

```
npm i
```

2) Configure environment

Create `.env.local` with your API key (already created in this repo):

```
GEMINI_API_KEY=your_api_key_here
```

3) Run the app

```
npm run dev
```

Open http://localhost:3000

### Usage

- Write in the Journal panel; auto-generates every 30s and skips if unchanged.
- Paste images (Cmd+V) or add by URL to include as references.
- Outputs are added as image shapes on the tldraw canvas and also listed in a preview grid.
- Style defaults to Photorealistic; adjust aspect hint and negative cues as needed.

### Notes

- The API route `/api/generate` calls model `gemini-2.5-flash-image-preview` via `@google/genai`.
- Production build may fail offline due to Google Fonts; dev mode is fine.
