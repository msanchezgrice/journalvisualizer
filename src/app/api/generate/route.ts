import { NextRequest, NextResponse } from 'next/server'
import { GoogleGenAI } from '@google/genai'

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

    if (!prompt && imagesBase64.length === 0) {
      return NextResponse.json({ error: 'Prompt or images required' }, { status: 400 })
    }

    const ai = new GoogleGenAI({ apiKey })

    const parts: Array<{ text: string } | { inlineData: { data: string; mimeType: string } }> = []
    if (prompt) parts.push({ text: prompt })
    for (const img of imagesBase64) {
      if (!img?.data || !img?.mime_type) continue
      parts.push({ inlineData: { data: img.data, mimeType: img.mime_type } })
    }

    const resp = await ai.models.generateContent({
      model: 'gemini-2.5-flash-image-preview',
      contents: parts,
    })

    const partsOut = (resp as GenerateResponse)?.candidates?.[0]?.content?.parts ?? []
    const imagePart = partsOut.find((p) => p?.inlineData)?.inlineData
    if (!imagePart) {
      return NextResponse.json({ error: 'No image returned' }, { status: 502 })
    }

    return NextResponse.json({ mimeType: imagePart.mimeType || 'image/png', data: imagePart.data })
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
