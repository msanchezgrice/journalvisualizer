"use client"

import { Tldraw } from '@tldraw/tldraw'
import '@tldraw/tldraw/tldraw.css'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import NextImage from 'next/image'

type InlineImage = { mime_type: string; data: string }

type IntervalOption = 30000 | 60000 | 120000

const DEFAULT_INTERVAL: IntervalOption = 60000

export default function Home() {
  const [running, setRunning] = useState(true)
  const [intervalMs, setIntervalMs] = useState<IntervalOption>(DEFAULT_INTERVAL)
  const [skipIfUnchanged, setSkipIfUnchanged] = useState(true)
  const [stylePreset, setStylePreset] = useState('Photorealistic')
  const [aspectHint, setAspectHint] = useState('16:9 cinematic frame')
  const [negative, setNegative] = useState('')
  const [modelMode, setModelMode] = useState<'auto' | 'gemini' | 'imagen'>('auto')
  const [journalByPage, setJournalByPage] = useState<Record<string, string>>({})
  const [currentPageId, setCurrentPageId] = useState<string>('default')
  const [lastError, setLastError] = useState<string | null>(null)
  const [hasKey, setHasKey] = useState<boolean | null>(null)
  const [backoffUntil, setBackoffUntil] = useState<number | null>(null)
  const [nextDue, setNextDue] = useState<number | null>(null)
  const [secondsLeft, setSecondsLeft] = useState<number | null>(null)
  const GEMINI_MIN_SPACING_MS = 60000
  const lastGeminiAttemptRef = useRef<number>(0)

  // Included items (for MVP, journal only; images by URL/paste added below)
  const [includedImages, setIncludedImages] = useState<InlineImage[]>([])

  const lastCtxRef = useRef<string>('')
  const inFlightRef = useRef(false)

  const journalForPage = journalByPage[currentPageId] ?? ''
  const prompt = useMemo(() => composePrompt({
    journal: journalForPage,
    stylePreset,
    aspectHint,
    negative,
  }), [journalForPage, stylePreset, aspectHint, negative])

  // Health check for env key
  useEffect(() => {
    let mounted = true
    fetch('/api/health')
      .then((r) => r.json())
      .then((j) => { if (mounted) setHasKey(Boolean(j?.hasKey)) })
      .catch(() => { if (mounted) setHasKey(false) })
    return () => { mounted = false }
  }, [])

  async function insertImageIntoTldraw(url: string, mime: string, pagePos?: { x: number; y: number }) {
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
          meta: {},
          props: { src: url, w, h, mimeType: mime, isAnimated: false, name: `image-${new Date().toISOString()}` },
        },
      ])
      const screenCenter = editor.getViewportScreenCenter?.() || { x: 0, y: 0 }
      // Convert to page coordinates if available, else use provided page position
      const pageCenter = pagePos ?? (editor.screenToPage ? editor.screenToPage(screenCenter) : screenCenter)
      editor.createShapes?.([
        {
          id: `shape:${Math.random().toString(36).slice(2)}`,
          type: 'image',
          x: pageCenter.x - w / 2,
          y: pageCenter.y - h / 2,
          props: { w, h, assetId: id },
        },
      ])
    } catch (e) {
      console.warn('Could not insert into tldraw, keeping in preview only', e)
    }
  }

  type TLCompatAsset = Record<string, unknown>
  type TLCompatShape = Record<string, unknown>
  type TLCompatEditor = { getCurrentPageId?: () => string }
  
  const editorRef = useRef<{
    createAssets?: (assets: TLCompatAsset[]) => void
    createShapes?: (shapes: TLCompatShape[]) => void
    getViewportScreenCenter?: () => { x: number; y: number }
    screenToPage?: (pt: { x: number; y: number }) => { x: number; y: number }
  } | null>(null)

  function handleMount(editor: unknown) {
    editorRef.current = editor as {
      createAssets?: (assets: TLCompatAsset[]) => void
      createShapes?: (shapes: TLCompatShape[]) => void
      getViewportScreenCenter?: () => { x: number; y: number }
      screenToPage?: (pt: { x: number; y: number }) => { x: number; y: number }
    }
  }

  // Track current tldraw page id to scope journal per page
  useEffect(() => {
    const id = setInterval(() => {
      const ed = editorRef.current as TLCompatEditor | null
      const pid = ed?.getCurrentPageId?.() ?? 'default'
      setCurrentPageId((prev) => (prev === pid ? prev : pid))
    }, 500)
    return () => clearInterval(id)
  }, [])

  const doGenerate = useCallback(async (ctxKeyOverride?: string) => {
    const ctxKey = ctxKeyOverride ?? JSON.stringify({ prompt, includedImages })
    inFlightRef.current = true
    try {
      const res = await fetch('/api/generate', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ prompt, imagesBase64: includedImages, modelMode, aspectHint: simplifiedAspect(aspectHint), negative }),
      })
      if (!res.ok) {
        let msg = 'Generation failed'
        try {
          const j = await res.json();
          msg = j?.error || msg
          if (res.status === 429) {
            const retry = typeof j?.retryDelaySec === 'number' ? j.retryDelaySec : 60
            setBackoffUntil(Date.now() + retry * 1000)
          }
        } catch {}
        setLastError(msg)
        throw new Error(msg)
      }
      const { data, mimeType, modelUsed } = await res.json()
      const dataUrl = `data:${mimeType};base64,${data}`
      await insertImageIntoTldraw(dataUrl, mimeType)
      setPreview((prev) => [{ url: dataUrl, ts: Date.now() }, ...prev].slice(0, 12))
      lastCtxRef.current = ctxKey
      setLastError(null)
      setBackoffUntil(null)
      if ((modelMode === 'gemini' || modelMode === 'auto') && modelUsed === 'gemini') {
        lastGeminiAttemptRef.current = Date.now()
      }
      setNextDue(Date.now() + intervalMs)
    } catch (e) {
      console.error(e)
    } finally {
      inFlightRef.current = false
    }
  }, [prompt, includedImages, intervalMs, modelMode, aspectHint, negative])

  // Auto-generation scheduler
  useEffect(() => {
    if (!running) return
    // set initial due if missing
    if (!nextDue) setNextDue(Date.now() + intervalMs)
    const id = setInterval(async () => {
      // reset next due at each tick
      setNextDue(Date.now() + intervalMs)
      if (inFlightRef.current) return
      if (backoffUntil && Date.now() < backoffUntil) return
      if ((modelMode === 'gemini' || modelMode === 'auto') && Date.now() - lastGeminiAttemptRef.current < GEMINI_MIN_SPACING_MS) {
        // Respect Gemini rate suggestions by spacing calls ~60s apart
        setNextDue(lastGeminiAttemptRef.current + GEMINI_MIN_SPACING_MS)
        return
      }
      const ctxKey = JSON.stringify({ prompt, includedImages })
      if (skipIfUnchanged && ctxKey === lastCtxRef.current) return
      await doGenerate(ctxKey)
    }, intervalMs)
    return () => clearInterval(id)
  }, [running, intervalMs, skipIfUnchanged, prompt, includedImages, backoffUntil, nextDue, doGenerate, modelMode])

  // Ensure the initial auto-run triggers even if interval loop hasn't ticked yet
  useEffect(() => {
    if (!running) return
    const timer = setTimeout(async () => {
      if (inFlightRef.current) return
      if (backoffUntil && Date.now() < backoffUntil) return
      if ((modelMode === 'gemini' || modelMode === 'auto') && Date.now() - lastGeminiAttemptRef.current < GEMINI_MIN_SPACING_MS) return
      const ctxKey = JSON.stringify({ prompt, includedImages })
      if (skipIfUnchanged && ctxKey === lastCtxRef.current) return
      await doGenerate(ctxKey)
    }, intervalMs)
    return () => clearTimeout(timer)
  }, [running, intervalMs, skipIfUnchanged, prompt, includedImages, backoffUntil, modelMode, doGenerate])

  // Countdown for next scheduled run or backoff
  useEffect(() => {
    const id = setInterval(() => {
      if (backoffUntil && Date.now() < backoffUntil) {
        setSecondsLeft(Math.max(0, Math.ceil((backoffUntil - Date.now()) / 1000)))
      } else if (running && nextDue) {
        setSecondsLeft(Math.max(0, Math.ceil((nextDue - Date.now()) / 1000)))
      } else {
        setSecondsLeft(null)
      }
    }, 1000)
    return () => clearInterval(id)
  }, [running, backoffUntil, nextDue])

  

  // Paste / URL import for included images
  const [imageUrlInput, setImageUrlInput] = useState('')
  async function addImageByUrl() {
    try {
      if (!imageUrlInput) return
      const resp = await fetch(imageUrlInput)
      const blob = await resp.blob()
      const arrayBuf = await blob.arrayBuffer()
      const b64 = arrayBufferToBase64(arrayBuf)
      setIncludedImages((imgs) => [{ mime_type: blob.type || 'image/png', data: b64 }, ...imgs].slice(0, 10))
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
              if (b64) setIncludedImages((imgs) => [{ mime_type: meta || 'image/png', data: b64 }, ...imgs].slice(0, 10))
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

  function handleThumbDragStart(e: React.DragEvent<HTMLDivElement>, url: string) {
    // Provide both uri-list and plain text so drop targets can read either
    try {
      e.dataTransfer.setData('text/uri-list', url)
      e.dataTransfer.setData('text/plain', url)
      e.dataTransfer.effectAllowed = 'copy'
    } catch {}
  }

  function handleDeleteThumb(ts: number) {
    setPreview((prev) => prev.filter((p) => p.ts !== ts))
  }

  function mimeFromDataUrl(dataUrl: string): string {
    const m = dataUrl.match(/^data:(.*?);base64,/)
    return m?.[1] || 'image/png'
  }

  function handleCanvasDragOver(e: React.DragEvent<HTMLDivElement>) {
    // Allow dropping images on the canvas surface
    e.preventDefault()
  }

  async function handleCanvasDrop(e: React.DragEvent<HTMLDivElement>) {
    e.preventDefault()
    const dataUrl = e.dataTransfer.getData('text/uri-list') || e.dataTransfer.getData('text/plain')
    if (!dataUrl) return
    const mime = dataUrl.startsWith('data:') ? mimeFromDataUrl(dataUrl) : 'image/png'
    const editor = editorRef.current
    const screenPt = { x: e.clientX, y: e.clientY }
    const pagePos = editor?.screenToPage ? editor.screenToPage(screenPt) : undefined
    await insertImageIntoTldraw(dataUrl, mime, pagePos)
  }

  return (
    <div className="flex h-full min-h-0 w-full flex-wrap">
      <div
        className="flex-1 min-w-0 min-h-0 relative"
        onDragOver={handleCanvasDragOver}
        onDrop={handleCanvasDrop}
      >
        <Tldraw className="h-full w-full" onMount={handleMount} />
        <div className="absolute left-1/2 top-1/2 -translate-x-1/2 -translate-y-1/2 z-10 w-[min(90%,640px)] pointer-events-auto">
          <textarea
            className="w-full min-h-[120px] rounded border border-black/10 dark:border-white/10 p-2 text-sm bg-white/80 dark:bg-black/40 backdrop-blur"
            placeholder="Write here..."
            value={journalForPage}
            onChange={(e) => setJournalByPage((prev) => ({ ...prev, [currentPageId]: e.target.value }))}
          />
        </div>
      </div>
      <div className="w-full md:w-[380px] border-l border-black/10 dark:border-white/10 p-3 flex flex-col gap-3 overflow-y-auto max-h-screen md:h-full min-h-0">
        {hasKey === false && (
          <div className="text-xs text-red-700 dark:text-red-300 border border-red-500/30 bg-red-50 dark:bg-red-950/30 rounded p-2">
            Missing GEMINI_API_KEY. Set it in Vercel Project Settings → Environment Variables and redeploy.
          </div>
        )}
        <h3 className="text-sm font-semibold">Generation</h3>
        <div className="flex flex-wrap items-center gap-2 text-sm">
          <label>Model</label>
          <select
            className="border rounded px-2 py-1 bg-transparent"
            value={modelMode}
            onChange={(e) => setModelMode(e.target.value as 'auto' | 'gemini' | 'imagen')}
          >
            <option value="auto">Auto (Gemini → Imagen)</option>
            <option value="gemini">Gemini 2.5 Flash Image</option>
            <option value="imagen">Imagen 4.0</option>
          </select>
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
              const ctxKey = JSON.stringify({ prompt, includedImages })
              await doGenerate(ctxKey)
            }}
          >
            Generate Now
          </button>
        </div>
        {(modelMode === 'gemini' || modelMode === 'auto') && (
          <div className="text-xs text-gray-600 dark:text-gray-300 border border-gray-500/20 rounded p-2">
            Gemini image calls are spaced ~60s to respect limits.
          </div>
        )}
        {lastError && (
          <div className="text-xs text-red-600 dark:text-red-400 border border-red-500/30 rounded p-2">
            {lastError}
          </div>
        )}
        {backoffUntil && Date.now() < backoffUntil && (
          <div className="text-xs text-amber-700 dark:text-amber-300 border border-amber-500/30 bg-amber-50 dark:bg-amber-950/30 rounded p-2">
            Rate limited. Auto-resumes in {secondsLeft ?? ''}s.
          </div>
        )}
        {running && !backoffUntil && secondsLeft !== null && (
          <div className="text-xs text-gray-600 dark:text-gray-300 border border-gray-500/20 rounded p-2">
            Next generation in {secondsLeft}s.
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
        {(modelMode === 'gemini' || modelMode === 'auto') && (
          <div className="text-[11px] text-gray-500">Gemini uses up to 2 reference images per request in this app. Imagen (basic) ignores references.</div>
        )}
        <div className="flex flex-wrap gap-2">
          {includedImages.map((img, i) => (
            <div key={i} className="w-20 h-20 bg-black/5 dark:bg-white/5 relative">
              <NextImage alt="included" src={`data:${img.mime_type};base64,${img.data}`} fill sizes="80px" className="object-cover w-full h-full" unoptimized />
            </div>
          ))}
        </div>

        <h3 className="text-sm font-semibold mt-2">Prompt Preview</h3>
        <textarea
          readOnly
          value={prompt}
          rows={3}
          className="text-xs w-full border rounded p-2 bg-transparent resize-y"
        />

        <h3 className="text-sm font-semibold mt-2">Latest Images</h3>
        <div className="grid grid-cols-2 gap-2">
          {preview.map((p) => (
            <div
              key={p.ts}
              className="relative w-full h-28"
              draggable
              onDragStart={(e) => handleThumbDragStart(e, p.url)}
            >
              <button
                type="button"
                aria-label="Delete image"
                title="Delete"
                className="absolute top-1 right-1 z-10 rounded bg-black/60 text-white text-xs leading-none px-2 py-1 hover:bg-black/80"
                onClick={() => handleDeleteThumb(p.ts)}
              >
                ×
              </button>
              <NextImage
                alt="generated"
                src={p.url}
                fill
                sizes="(max-width: 768px) 50vw, 33vw"
                className="object-cover rounded"
                unoptimized
              />
            </div>
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


function loadImage(url: string): Promise<HTMLImageElement> {
  return new Promise((resolve, reject) => {
    const img = new Image()
    img.onload = () => resolve(img)
    img.onerror = (e: unknown) => reject(e)
    img.src = url
  })
}

function simplifiedAspect(input: string) {
  // Extract common aspect strings if present
  const m = input.match(/(1:1|3:4|4:3|9:16|16:9)/)
  return m ? m[1] : ''
}
