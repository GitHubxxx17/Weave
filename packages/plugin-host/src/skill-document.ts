import { skillNamePattern } from '@weave/plugin';
import { isAlias, isMap, isPair, isScalar, isSeq, parseDocument, visit } from 'yaml';
import { z } from 'zod';

import { SkillHostError, type ParsedSkillDocument } from './skill-types.js';

const scalarText = (limit: number) =>
  z
    .string()
    .max(limit)
    .refine((value) => !value.includes('\0'));
const schema = z
  .object({
    name: z.string().max(64).regex(skillNamePattern),
    description: scalarText(8192)
      .transform((value) => value.replace(/\s+/g, ' ').trim())
      .pipe(z.string().min(1).max(1024)),
    license: scalarText(1024).optional(),
    compatibility: scalarText(500).optional(),
    metadata: z
      .record(scalarText(100).min(1), scalarText(1024))
      .refine((value) => Object.keys(value).length <= 32)
      .optional(),
    'disable-model-invocation': z.boolean().optional(),
    'user-invocable': z.boolean().optional(),
  })
  .catchall(scalarText(1024));

/** Parse bounded YAML data without interpreting tags, aliases, scripts or tool declarations. */
export function parseSkillDocument(text: string, expectedName: string): ParsedSkillDocument {
  try {
    if (Buffer.byteLength(text, 'utf8') > 64 * 1024 || text.includes('\0'))
      throw new Error('size or NUL');
    const source = text.replace(/^\ufeff/, '').replace(/\r\n/g, '\n');
    const delimiters = /^---\n([\s\S]*?)\n---(?:\n|$)/.exec(source);
    if (delimiters === null || Buffer.byteLength(delimiters[1]!, 'utf8') > 8 * 1024)
      throw new Error('frontmatter');
    const document = parseDocument(delimiters[1]!, {
      uniqueKeys: true,
      strict: true,
      schema: 'core',
    });
    if (document.errors.length > 0 || document.warnings.length > 0 || !isMap(document.contents))
      throw new Error('YAML');
    visit(document, (_key, node, ancestors) => {
      if (
        isAlias(node) ||
        (typeof node === 'object' &&
          node !== null &&
          'anchor' in node &&
          node.anchor !== undefined) ||
        (typeof node === 'object' && node !== null && 'tag' in node && node.tag !== undefined) ||
        isSeq(node)
      )
        throw new Error('unsupported YAML feature');
      if (isMap(node) && ancestors.filter(isMap).length > 1) throw new Error('nested YAML');
      if (isPair(node) && !isScalar(node.key)) throw new Error('complex YAML key');
    });
    const data = schema.parse(document.toJS({ maxAliasCount: 0 }));
    const instructions = source.slice(delimiters[0].length);
    if (data.name !== expectedName || instructions.trim() === '') throw new Error('name or body');
    return Object.freeze({
      name: data.name,
      description: data.description,
      instructions,
      invocation: Object.freeze({
        user: data['user-invocable'] ?? true,
        model: !(data['disable-model-invocation'] ?? false),
      }),
      ...(data.license === undefined ? {} : { license: data.license }),
      ...(data.compatibility === undefined ? {} : { compatibility: data.compatibility }),
      ...(data.metadata === undefined ? {} : { metadata: Object.freeze(data.metadata) }),
    });
  } catch (cause: unknown) {
    throw new SkillHostError('skill-invalid-document', { cause });
  }
}
