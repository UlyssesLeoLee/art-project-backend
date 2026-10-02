// HTTP request validation schemas (zod) — issue #3.
// Every /account/* and /api/* body is parsed through these before touching the DB.

import { z } from 'zod'

export const LoginBody = z.object({
  platform: z.union([z.string(), z.number()]).transform(String),
  account: z.string().max(128).optional().default(''),
  token: z.string().max(512).optional().default(''),
  deviceID: z.string().max(128).optional().default(''),
  serverID: z.string().max(64).optional().default(''),
  accountUUID: z.union([z.string().uuid(), z.literal('')]).optional().default(''),
  binVersion: z.string().max(32).optional().default(''),
})

export const BindBody = z.object({
  accountUUID: z.string().uuid(),
  platform: z.union([z.string(), z.number()]).transform(String),
  account: z.string().min(1).max(128),
  token: z.string().max(512).optional().default(''),
})

export const RegisterBody = z.object({
  platform: z.union([z.string(), z.number()]).transform(String),
  account: z.string().min(3).max(64).regex(/^[A-Za-z0-9_.@-]+$/, 'account: alnum/._@- only'),
  password: z.string().min(6).max(128),
  deviceID: z.string().max(128).optional().default(''),
})

export const ActivationBody = z.object({
  accountUUID: z.string().uuid(),
  code: z.string().min(1).max(64),
})

export type LoginInput = z.infer<typeof LoginBody>
export type BindInput = z.infer<typeof BindBody>
export type RegisterInput = z.infer<typeof RegisterBody>
export type ActivationInput = z.infer<typeof ActivationBody>

/** Parse with a schema; on failure returns a 400-able error payload. */
export function parseBody<T extends z.ZodTypeAny>(schema: T, data: unknown):
  { ok: true; data: z.infer<T> } | { ok: false; error: { code: 'BAD_REQUEST'; issues: Array<{ path: string; message: string }> } } {
  const r = schema.safeParse(data)
  if (r.success) return { ok: true, data: r.data }
  return {
    ok: false,
    error: {
      code: 'BAD_REQUEST',
      issues: r.error.issues.slice(0, 10).map(i => ({ path: i.path.join('.'), message: i.message })),
    },
  }
}