/** Ссылка на файл, отправленный клиенту из CRM (ChatFile): по ней Instagram скачивает вложение, по ней же его открывает переписка */
export const chatFileUrl = (token: string) => `/api/chats/out/${token}`;
