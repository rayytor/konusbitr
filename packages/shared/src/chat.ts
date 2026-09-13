import { z } from 'zod';
import { CitationSchema } from './citation.js';

export const ChatRoleSchema = z.enum(['user', 'assistant', 'system']);
export type ChatRole = z.infer<typeof ChatRoleSchema>;

export const ChatMessageViewSchema = z.object({
  id: z.string(),
  conversationId: z.string(),
  role: ChatRoleSchema,
  content: z.string(),
  citations: z.array(CitationSchema).nullish(),
  usage: z.record(z.string(), z.unknown()).nullish(),
  createdAt: z.string(),
});
export type ChatMessageView = z.infer<typeof ChatMessageViewSchema>;

export const ConversationScopeSchema = z.enum(['document', 'corpus']);
export type ConversationScope = z.infer<typeof ConversationScopeSchema>;

export const ConversationViewSchema = z.object({
  id: z.string(),
  orgId: z.string(),
  userId: z.string(),
  scope: ConversationScopeSchema,
  documentIds: z.array(z.string()),
  title: z.string().nullish(),
  createdAt: z.string(),
  updatedAt: z.string(),
  messages: z.array(ChatMessageViewSchema).optional(),
});
export type ConversationView = z.infer<typeof ConversationViewSchema>;

export const ChatRequestSchema = z
  .object({
    conversationId: z.string().min(1).optional(),
    documentId: z.string().min(1).optional(),
    corpus: z.boolean().optional(),
    message: z.string().min(1),
  })
  .refine(
    (val) =>
      val.conversationId !== undefined || val.documentId !== undefined || val.corpus === true,
    { message: 'Must provide either conversationId, documentId, or corpus: true' },
  );
export type ChatRequest = z.infer<typeof ChatRequestSchema>;

export const CreateConversationRequestSchema = z.object({
  documentId: z.string().min(1).optional(),
  corpus: z.boolean().optional(),
  title: z.string().optional(),
});
export type CreateConversationRequest = z.infer<typeof CreateConversationRequestSchema>;

export const UpdateConversationRequestSchema = z.object({
  title: z.string().min(1).max(200),
});
export type UpdateConversationRequest = z.infer<typeof UpdateConversationRequestSchema>;
