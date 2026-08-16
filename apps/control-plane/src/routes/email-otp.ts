/**
 * Email-OTP IMAP config (operator-only). Sets/clears the per-deployment inbox the email-OTP watcher polls.
 *
 *   PUT    /api/email-otp-config  { host, port, secure?, username, password, folder?, enabled? } -> 200 view
 *   GET    /api/email-otp-config                                                                  -> { config } (NO password)
 *   DELETE /api/email-otp-config                                                                  -> 204
 */
import type { FastifyInstance } from 'fastify';
import { z } from 'zod';
import { db } from '../db/client';
import { requireSelfHostedOperator } from '../auth/middleware';
import { writeAudit } from '../auth/audit';
import { setEmailOtpConfig, getEmailOtpConfigView, deleteEmailOtpConfig } from '../data/email-otp-config';

const configSchema = z.object({
  host: z.string().min(1).max(253),
  port: z.number().int().positive().max(65535),
  secure: z.boolean().default(true),
  username: z.string().min(1).max(320),
  password: z.string().min(1).max(1024),
  folder: z.string().min(1).max(200).default('INBOX'),
  enabled: z.boolean().default(true),
});

export async function emailOtpRoutes(app: FastifyInstance): Promise<void> {
  app.put('/api/email-otp-config', { preHandler: requireSelfHostedOperator }, async (req, reply) => {
    const parsed = configSchema.safeParse(req.body);
    if (!parsed.success) return reply.code(400).send({ error: parsed.error.message });
    const view = await setEmailOtpConfig(db, parsed.data);
    await writeAudit(db, { actorType: 'operator', actorId: req.operatorSubject, action: 'email_otp_config.set', targetType: 'email_otp_config', sourceIp: req.ip });
    return view; // never includes the password
  });

  app.get('/api/email-otp-config', { preHandler: requireSelfHostedOperator }, async () => {
    return { config: await getEmailOtpConfigView(db) };
  });

  app.delete('/api/email-otp-config', { preHandler: requireSelfHostedOperator }, async (req, reply) => {
    const ok = await deleteEmailOtpConfig(db);
    if (ok) await writeAudit(db, { actorType: 'operator', actorId: req.operatorSubject, action: 'email_otp_config.delete', targetType: 'email_otp_config', sourceIp: req.ip });
    return reply.code(204).send();
  });
}
