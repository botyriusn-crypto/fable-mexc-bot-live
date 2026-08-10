import { NextResponse } from "next/server"
import type { NextRequest } from "next/server"

/**
 * Authentication middleware for admin API endpoints
 * Validates API_KEY from request headers against process.env.API_KEY
 */
export function verifyApiKey(request: NextRequest): NextResponse | null {
  const apiKey = process.env.API_KEY
  
  // If no API_KEY is configured, allow access (for development)
  if (!apiKey) {
    console.warn('[AUTH] API_KEY not configured - allowing access')
    return null
  }
  
  const authHeader = request.headers.get('authorization')
  const providedKey = authHeader?.replace('Bearer ', '') || request.headers.get('x-api-key')
  
  if (!providedKey || providedKey !== apiKey) {
    console.log('[AUTH] Invalid or missing API key')
    return NextResponse.json(
      { error: 'Unauthorized - valid API key required' },
      { status: 401, headers: { 'WWW-Authenticate': 'Bearer' } }
    )
  }
  
  return null
}

/**
 * Helper to check if API_KEY is configured
 */
export function isApiKeyConfigured(): boolean {
  return !!process.env.API_KEY
}
