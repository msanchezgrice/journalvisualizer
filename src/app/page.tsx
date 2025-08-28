"use client"

import { Tldraw } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'
import { useEffect, useMemo, useRef, useState } from 'react'

type InlineImage = { mime_type: string; data: string }

type IntervalOption = 30000 | 60000 | 120000

const DEFAULT_INTERVAL: IntervalOption = 30000

export default function Home() {
  const [running, setRunning] = useState(true)
  const [intervalMs, setIntervalMs] = useState<IntervalOption>(DEFAULT_INTERVAL)
  const [skipIfUnchanged, setSkipIfUnchanged] = useState(true)
  const [stylePreset, setStylePreset] = useState('Photorealistic')
  const [aspectHint, setAspectHint] = useState('16:9 cinematic frame')
  const [negative, setNegative] = useState('')
  const [journal, setJournal] = useState('')
  const [lastError, setLastError] = useState<string | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)

  // Included items (for MVP, journal only; images by URL/paste added below)
  const [includedImages, setIncludedImages] = useState<InlineImage[]>([])

  const lastCtxRef = useRef<string>('')
  const inFlightRef = useRef(false)

  const prompt = useMemo(() => composePrompt({
    journal,
    stylePreset,
    aspectHint,
    negative,
  }), [journal, stylePreset, aspectHint, negative])

  // Health check for env key
  useEffect(() => {
    let mounted = true
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => { if (mounted) setHasKey(Boolean(j?.hasKey)) })
      .catch(() => { if (mounted) setHasKey(false) })
    return () => { mounted = false }
  }, [])

  async function insertImageIntoTldraw(url: string, mime: string) {
    const editor = editorRef.current
    if (!editor) return
    // Load image to determine dimensions
    const imgEl = await loadImage(url)
    const w = Math.min(800, imgEl.naturalWidth || imgEl.width || 800)
    const h = Math.round((imgEl.naturalHeight || imgEl.height || 800) * (w / (imgEl.naturalWidth || imgEl.width || w)))
    const id = `asset:${Math.random().toString(36).slice(2)}`
    try {
      // Create asset + shape (API shape is flexible; using any to avoid strict types)
      editor.createAssets?.([
        {
          id,
          type: 'image',
          typeName: 'asset',
          props: { src: url, w, h, mimeType: mime },
        },
      ])
      const center = editor.getViewportScreenCenter?.() || { x: 0, y: 0 }
      editor.createShapes?.([
        {
          id: `shape:${Math.random().toString(36).slice(2)}`,
          type: 'image',
          x: center.x - w / 2,
          y: center.y - h / 2,
          props: { w, h, assetId: id },
        },
      ])
    } catch (e) {
      console.warn('Could not insert into tldraw, keeping in preview only', e)
    }
  }

  const editorRef = useRef<{
    createAssets?: (assets: { id: string; type: 'image'; typeName: 'asset'; props: { src: string; w: number; h: number; mimeType: string } }[]) => void
    createShapes?: (shapes: { id: string; type: 'image'; x: number; y: number; props: { w: number; h: number; assetId: string } }[]) => void
    getViewportScreenCenter?: () => { x: number; y: number }
  } | null>(null)

  function handleMount(editor: unknown) {
    editorRef.current = editor as {
      createAssets?: (assets: { id: string; type: 'image'; typeName: 'asset'; props: { src: string; w: number; h: number; mimeType: string } }[]) => void
      createShapes?: (shapes: { id: string; type: 'image'; x: number; y: number; props: { w: number; h: number; assetId: string } }[]) => void
      getViewportScreenCenter?: () => { x: number; y: number }
    }
  }

  useEffect(() => {
    if (!running) return
    const id = setInterval(async () => {
      if (inFlightRef.current) return
      const ctxKey = JSON.stringify({ prompt, includedImages })
      if (skipIfUnchanged && ctxKey === lastCtxRef.current) return
      inFlightRef.current = true
      try {
        const res = await fetch('/api/generate', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ prompt, imagesBase64: includedImages }),
        })
        if (!res.ok) {
          let msg = 'Generation failed'
          try { const j = await res.json(); msg = j?.error || msg } catch {}
          setLastError(msg)
          throw new Error(msg)
        }
        const { data, mimeType } = await res.json()
        const blob = b64ToBlob(data, mimeType)
        const url = URL.createObjectURL(blob)
        // Insert into tldraw as an image shape
        await insertImageIntoTldraw(url, mimeType)
        // Also keep a small preview list
        setPreview((prev) => [{ url, ts: Date.now() }, ...prev].slice(0, 12))
        lastCtxRef.current = ctxKey
        setLastError(null)
      } catch (e) {
        console.error(e)
      } finally {
        inFlightRef.current = false
      }
    }, intervalMs)
    return () => clearInterval(id)
  }, [running, intervalMs, skipIfUnchanged, prompt, includedImages])

  // Paste / URL import for included images
  const [imageUrlInput, setImageUrlInput] = useState('')
  async function addImageByUrl() {
    try {
      if (!imageUrlInput) return
      const resp = await fetch(imageUrlInput)
      const blob = await resp.blob()
      const arrayBuf = await blob.arrayBuffer()
      const b64 = arrayBufferToBase64(arrayBuf)
      setIncludedImages((imgs) => [
        { mime_type: blob.type || 'image/png', data: b64 },
        ...imgs,
      ])
      setImageUrlInput('')
    } catch (e) {
      console.error('Failed to load image URL', e)
    }
  }

  useEffect(() => {
    function onPaste(e: ClipboardEvent) {
      const items = e.clipboardData?.items
      if (!items) return
      for (const item of items) {
        if (item.kind === 'file') {
          const file = item.getAsFile()
          if (!file) continue
          const reader = new FileReader()
          reader.onload = () => {
            const result = reader.result
            if (typeof result === 'string') {
              const [, meta, b64] = result.match(/^data:(.*?);base64,(.*)$/) || []
              if (b64) setIncludedImages((imgs) => [{ mime_type: meta || 'image/png', data: b64 }, ...imgs])
            }
          }
          reader.readAsDataURL(file)
        }
      }
    }
    window.addEventListener('paste', onPaste)
    return () => window.removeEventListener('paste', onPaste)
  }, [])

  // Preview list until we wire insertion into tldraw programmatically
  const [preview, setPreview] = useState<{ url: string; ts: number }[]>([])

  return (
    <div className="flex h-full w-full">
      <div className="flex-1 min-w-0">
        <Tldraw className="h-full w-full" onMount={handleMount} />
      </div>
      <div className="w-[380px] border-l border-black/10 dark:border-white/10 p-3 flex flex-col gap-3 overflow-y-auto">
        <h2 className="text-base font-semibold">Journal</h2>
        <textarea
          className="w-full min-h-[140px] rounded border border-black/10 dark:border-white/10 p-2 text-sm bg-transparent"
          placeholder="Write here..."
          value={journal}
          onChange={(e) => setJournal(e.target.value)}
        />
        {hasKey === false && (
          <div className="text-xs text-red-700 dark:text-red-300 border border-red-500/30 bg-red-50 dark:bg-red-950/30 rounded p-2">
            Missing GEMINI_API_KEY. Set it in Vercel Project Settings → Environment Variables and redeploy.
          </div>
        )}
        <h3 className="text-sm font-semibold">Generation</h3>
        <div className="flex items-center gap-2 text-sm">
          <label>Interval</label>
          <select
            className="border rounded px-2 py-1 bg-transparent"
            value={intervalMs}
            onChange={(e) => setIntervalMs(Number(e.target.value) as IntervalOption)}
          >
            <option value={30000}>30s</option>
            <option value={60000}>60s</option>
            <option value={120000}>2m</option>
          </select>
          <label className="ml-3 flex items-center gap-1">
            <input type="checkbox" checked={running} onChange={(e) => setRunning(e.target.checked)} />
            Running
          </label>
          <label className="ml-3 flex items-center gap-1">
            <input type="checkbox" checked={skipIfUnchanged} onChange={(e) => setSkipIfUnchanged(e.target.checked)} />
            Skip if unchanged
          </label>
          <button
            className="ml-auto text-xs border px-2 py-1 rounded"
            onClick={async () => {
              // manual trigger
              lastCtxRef.current = ''
              setRunning(false)
              setTimeout(() => setRunning(true), 0)
            }}
          >
            Generate Now
          </button>
        </div>
        {lastError && (
          <div className="text-xs text-red-600 dark:text-red-400 border border-red-500/30 rounded p-2">
            {lastError}
          </div>
        )}

        <h3 className="text-sm font-semibold">Style</h3>
        <div className="grid grid-cols-2 gap-2 text-sm">
          <label className="col-span-2">Preset
            <select className="w-full border rounded px-2 py-1 bg-transparent" value={stylePreset} onChange={(e) => setStylePreset(e.target.value)}>
              <option>Photorealistic</option>
              <option>Cinematic</option>
              <option>Watercolor</option>
              <option>Anime</option>
            </select>
          </label>
          <label className="col-span-2">Aspect hint
            <input className="w-full border rounded px-2 py-1 bg-transparent" value={aspectHint} onChange={(e) => setAspectHint(e.target.value)} />
          </label>
          <label className="col-span-2">Negative cues
            <input className="w-full border rounded px-2 py-1 bg-transparent" value={negative} onChange={(e) => setNegative(e.target.value)} placeholder="e.g., no text artifacts" />
          </label>
        </div>

        <h3 className="text-sm font-semibold">Include Images</h3>
        <div className="flex gap-2">
          <input className="flex-1 border rounded px-2 py-1 bg-transparent text-sm" placeholder="Paste image URL" value={imageUrlInput} onChange={(e) => setImageUrlInput(e.target.value)} />
          <button className="text-sm border rounded px-2 py-1" onClick={addImageByUrl}>Add</button>
        </div>
        <div className="flex flex-wrap gap-2">
          {includedImages.map((img, i) => (
            <div key={i} className="w-20 h-20 bg-black/5 dark:bg-white/5 relative">
              <img className="object-cover w-full h-full" alt="included" src={`data:${img.mime_type};base64,${img.data}`} />
            </div>
          ))}
        </div>

        <h3 className="text-sm font-semibold mt-2">Prompt Preview</h3>
        <pre className="text-xs whitespace-pre-wrap border rounded p-2 bg-transparent max-h-40 overflow-auto">{prompt}</pre>

        <h3 className="text-sm font-semibold mt-2">Latest Images</h3>
        <div className="grid grid-cols-2 gap-2">
          {preview.map((p) => (
            <img key={p.ts} alt="generated" src={p.url} className="w-full h-28 object-cover rounded" />
          ))}
        </div>
      </div>
    </div>
  )
}

function composePrompt(opts: { journal: string; stylePreset: string; aspectHint: string; negative: string }) {
  const recent = opts.journal.slice(-600)
  const lines: string[] = []
  if (recent.trim()) {
    lines.push(`Describe and render a single coherent image based on this writing: ${recent}`)
  }
  lines.push(`Style: ${opts.stylePreset}. Camera: 85mm portrait, golden hour lighting.`)
  if (opts.aspectHint) lines.push(`Frame: ${opts.aspectHint}.`)
  if (opts.negative.trim()) lines.push(`Avoid: ${opts.negative}.`)
  lines.push('High-fidelity, realistic textures, consistent composition. No embedded text unless explicitly asked.')
  return lines.join('\n')
}

function arrayBufferToBase64(buffer: ArrayBuffer) {
  let binary = ''
  const bytes = new Uint8Array(buffer)
  const len = bytes.byteLength
  for (let i = 0; i < len; i++) binary += String.fromCharCode(bytes[i])
  return btoa(binary)
}

function b64ToBlob(b64Data: string, contentType = 'image/png', sliceSize = 512) {
  const byteCharacters = atob(b64Data)
  const byteArrays = []
  for (let offset = 0; offset < byteCharacters.length; offset += sliceSize) {
    const slice = byteCharacters.slice(offset, offset + sliceSize)
    const byteNumbers = new Array(slice.length)
    for (let i = 0; i < slice.length; i++) byteNumbers[i] = slice.charCodeAt(i)
    const byteArray = new Uint8Array(byteNumbers)
    byteArrays.push(byteArray)
  }
  return new Blob(byteArrays, { type: contentType })
}

function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = (e) => reject(e)
    img.src = url
  })
}
