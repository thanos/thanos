import { defineCollection } from 'astro:content';
import { glob } from 'astro/loaders';
import { z } from 'astro/zod';

const baseSchema = z.object({
  title: z.string(),
  description: z.string(),
  date: z.coerce.date(),
  tags: z.array(z.string()).default([]),
  draft: z.boolean().default(false),
});

const articleSchema = baseSchema.extend({
  /** Matches `series` collection entry id (filename without .md), e.g. `mining-foundations`. */
  series: z.string().optional(),
});

const articles = defineCollection({
  loader: glob({ base: './content/articles', pattern: '**/!(README).md' }),
  schema: articleSchema,
});

const series = defineCollection({
  loader: glob({ base: './content/series', pattern: '**/*.md' }),
  schema: baseSchema,
});

const notes = defineCollection({
  loader: glob({ base: './content/notes', pattern: '**/*.md' }),
  schema: baseSchema,
});

export const collections = { articles, series, notes };
