import { pgTable, text, timestamp, uniqueIndex } from 'drizzle-orm/pg-core';
import { ID_PREFIXES, newId } from '../id.js';

export const users = pgTable(
  'users',
  {
    id: text('id')
      .primaryKey()
      .$defaultFn(() => newId(ID_PREFIXES.user)),
    email: text('email').notNull(),
    name: text('name'),
    image: text('image'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('users_email_idx').on(table.email)],
);
