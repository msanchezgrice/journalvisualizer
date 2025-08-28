import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI, PersonGeneration } from '@google/genai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

type ImageInlineDataIn = { mime_type: string; data: string }
type PartOut = { text?: string; inlineData?: { data?: string; mimeType?: string } }
type GenerateResponse = { candidates?: Array<{ content?: { parts?: PartOut[] } }> }

export async function POST(req: NextRequest) {
  try {
    const apiKey = process.env.GEMINI_API_KEY
    if (!apiKey) {
      return NextResponse.json({ error: 'Missing GEMINI_API_KEY' }, { status: 500 })
    }

    const body = await req.json()
    const prompt: string = body?.prompt || ''
    const imagesBase64: ImageInlineDataIn[] = Array.isArray(body?.imagesBase64) ? body.imagesBase64 : []
    const modelMode: 'auto' | 'gemini' | 'imagen' = body?.modelMode === 'gemini' || body?.modelMode === 'imagen' ? body.modelMode : 'auto'

    if (!prompt && imagesBase64.length === 0) {
      return NextResponse.json({ error: 'Prompt or images required' }, { status: 400 })
    }

    const ai = new GoogleGenAI({ apiKey })

    async function tryGemini() {
      const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = []
      if (prompt) parts.push({ text: prompt })
      // Limit reference images to reduce payload / align with preview constraints
      for (const img of imagesBase64.slice(0, 2)) {
        if (!img?.data || !img?.mime_type) continue
        parts.push({ inlineData: { data: img.data, mimeType: img.mime_type } })
      }
      const resp = await ai.models.generateContent({
        model: 'gemini-2.5-flash-image-preview',
        contents: parts,
      })
      const partsOut = (resp as GenerateResponse)?.candidates?.[0]?.content?.parts ?? []
      const imagePart = partsOut.find((p) => p?.inlineData)?.inlineData
      if (!imagePart?.data) throw Object.assign(new Error('No image returned from Gemini'), { status: 502 })
      return { mimeType: imagePart.mimeType || 'image/png', data: imagePart.data, modelUsed: 'gemini' as const }
    }

    async function tryImagen() {
      // Map prompt settings
      const aspect = (body?.aspectHint || '').trim()
      const allowed = new Set(['1:1', '3:4', '4:3', '9:16', '16:9'])
      const aspectRatio = allowed.has(aspect) ? aspect : undefined
      const negativePrompt = (body?.negative || '').trim() || undefined
      const resp = await ai.models.generateImages({
        model: 'imagen-4.0-generate-001',
        prompt,
        config: {
          numberOfImages: 1,
          outputMimeType: 'image/png',
          personGeneration: PersonGeneration.ALLOW_ALL,
          imageSize: '1K',
          ...(aspectRatio ? { aspectRatio } : {}),
          ...(negativePrompt ? { negativePrompt } : {}),
        },
      })
      const g = resp?.generatedImages?.[0]?.image
      if (!g?.imageBytes) throw Object.assign(new Error('No image returned from Imagen'), { status: 502 })
      return { mimeType: g.mimeType || 'image/png', data: g.imageBytes, modelUsed: 'imagen' as const }
    }

    if (modelMode === 'gemini') {
      return NextResponse.json(await tryGemini())
    }
    if (modelMode === 'imagen') {
      return NextResponse.json(await tryImagen())
    }
    // auto: Gemini first, then Imagen fallback on known errors
    try {
      return NextResponse.json(await tryGemini())
    } catch (e: unknown) {
      const errObj = typeof e === 'object' && e !== null ? (e as Record<string, unknown>) : {}
      const msg = typeof errObj['message'] === 'string' ? (errObj['message'] as string) : String(e)
      const status = typeof errObj['status'] === 'number' ? (errObj['status'] as number) : 500
      const isQuota = /RESOURCE_EXHAUSTED|quota|429/i.test(msg) || status === 429
      if (isQuota || /No image returned/i.test(msg)) {
        try {
          return NextResponse.json(await tryImagen())
        } catch (e2: unknown) {
          const err2 = typeof e2 === 'object' && e2 !== null ? (e2 as Record<string, unknown>) : {}
          const raw = typeof err2['message'] === 'string' ? (err2['message'] as string) : 'Fallback failed'
          return NextResponse.json({ error: `Gemini failed (${msg}); Imagen failed (${raw})` }, { status: 502 })
        }
      }
      throw e
    }
  } catch (err: unknown) {
    console.error('Generate API error', err)
    const e = err as { message?: unknown; status?: unknown }
    const raw = typeof e.message === 'string' ? e.message : 'Generation failed'
    let status = typeof e.status === 'number' ? e.status : 500
    const isQuota = /RESOURCE_EXHAUSTED|quota|429/i.test(raw)
    if (isQuota) status = 429
    let retryDelaySec: number | undefined
    const m = raw.match(/retryDelay\\":\\"(\d+)s/)
    if (m) retryDelaySec = parseInt(m[1], 10)
    return NextResponse.json({ error: raw, status, retryDelaySec }, { status })
  }
}
