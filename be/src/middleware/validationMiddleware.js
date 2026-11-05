// validate({ body, query, params }) — zod schemas. Parsed (coerced, trimmed) values land in
// req.valid.{body,query,params}. Express 5 makes req.query read-only, hence req.valid.
import { badRequest } from '../utils/errors.js';

export function formatZodIssues(error) {
  return error.issues.map((i) => ({ field: i.path.join('.') || '(root)', message: i.message }));
}

export function validate(schemas) {
  return (req, _res, next) => {
    req.valid = req.valid || {};
    const errors = [];
    for (const part of ['params', 'query', 'body']) {
      if (!schemas[part]) continue;
      const result = schemas[part].safeParse(req[part] ?? {});
      if (result.success) req.valid[part] = result.data;
      else errors.push(...formatZodIssues(result.error).map((e) => ({ ...e, location: part })));
    }
    if (errors.length) throw badRequest('Validation failed', errors);
    next();
  };
}
