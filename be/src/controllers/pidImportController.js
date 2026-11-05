import multer from 'multer';
import { z } from 'zod';
import { env } from '../config/env.js';
import { sendSuccess } from '../utils/responseHandler.js';
import { requestContext } from './crudController.js';
import {
  parseUpload, validateRows, commitRecords, findingsToCsv, buildTemplate, INLINE_FINDINGS_LIMIT,
} from '../services/pidImportService.js';

/** Memory storage; size limit from env (default 10 MB); exactly one file in field "file". */
export const importUpload = multer({
  storage: multer.memoryStorage(),
  limits: { fileSize: env.IMPORT_MAX_FILE_MB * 1024 * 1024, files: 1 },
}).single('file');

export const importQuerySchema = z.object({
  mode: z.enum(['validate', 'commit']),
  on_existing: z.enum(['skip', 'update']).default('skip'),
  // validate only: `report=csv` returns the FULL findings list as a CSV download instead of JSON.
  report: z.enum(['json', 'csv']).default('json'),
});

export const templateQuerySchema = z.object({ format: z.enum(['csv', 'xlsx']).default('csv') });

export const pidImportController = {
  async import(req, res) {
    const { mode, on_existing: onExisting, report } = req.valid.query;
    const parsed = await parseUpload(req.file);
    const { records, findings, summary } = await validateRows(parsed, { onExisting });

    if (mode === 'validate' && report === 'csv') {
      res.setHeader('Content-Type', 'text/csv; charset=utf-8');
      res.setHeader('Content-Disposition', 'attachment; filename="pid-import-report.csv"');
      return res.send(findingsToCsv(findings));
    }

    const payload = {
      mode,
      on_existing: onExisting,
      summary,
      findings: findings.slice(0, INLINE_FINDINGS_LIMIT),
      findings_truncated: findings.length > INLINE_FINDINGS_LIMIT,
    };
    if (mode === 'validate') {
      return sendSuccess(res, { message: 'Import file validated (nothing was written)', data: payload });
    }

    const result = await commitRecords(records, {
      onExisting,
      filename: req.file.originalname,
      summary,
      ctx: requestContext(req),
    });
    return sendSuccess(res, { message: 'Import committed', data: { ...payload, result } });
  },

  async template(req, res) {
    const t = await buildTemplate(req.valid.query.format);
    res.setHeader('Content-Type', t.type);
    res.setHeader('Content-Disposition', `attachment; filename="pid-import-template.${t.ext}"`);
    res.send(t.body);
  },
};
