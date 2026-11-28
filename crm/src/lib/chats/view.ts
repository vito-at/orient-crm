import type { ChatMessage } from "@prisma/client";
import type { ChatAttachmentView, ChatMessageView } from "@/components/chats/chat-thread";

/** purged — файл, отправленный клиенту из CRM, удалён по сроку хранения (lib/doc-files.ts, purgeChatFiles) */
type StoredAttachment = { type: ChatAttachmentView["type"]; url?: string; fileId?: string; name?: string; purged?: boolean };

/** Сообщение для интерфейса: вложения Telegram — через прокси CRM (токен бота наружу не уходит) */
export function toMessageView(m: ChatMessage & { sender?: { name: string } | null }): ChatMessageView {
  const list = Array.isArray(m.attachments) ? (m.attachments as unknown as StoredAttachment[]) : [];
  return {
    id: m.id,
    direction: m.direction,
    text: m.text,
    at: m.createdAt.toISOString(),
    sender: m.sender?.name ?? null,
    isAi: m.isAi,
    attachments: list.map((a, i) => ({ type: a.type, name: a.name ?? null, src: a.url ?? (a.fileId ? `/api/chats/file?m=${m.id}&i=${i}` : null), ...(a.purged ? { purged: true } : {}) })),
  };
}
