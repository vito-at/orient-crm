import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { orientVisaConfig, verifyFileSignature } from "@/lib/orient-visa";
import { decryptBytes, logDocAccess } from "@/lib/doc-files";
import { clientIp } from "@/lib/login-guard";

export const dynamic = "force-dynamic";

/**
 * Файл визы или подтверждения отказа для сайта Orient Visa — по подписанной ссылке из события (живёт час).
 * Отдаются только документы заявок, пришедших с сайта.
 */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const cfg = await orientVisaConfig();
  const exp = req.nextUrl.searchParams.get("exp") ?? "";
  const sig = req.nextUrl.searchParams.get("sig") ?? "";
  if (!cfg || !verifyFileSignature(cfg.secret, id, exp, sig)) return new NextResponse("Forbidden", { status: 403 });
  const d = await prisma.leadDocument.findFirst({ where: { id, service: { externalId: { not: null } } } });
  if (!d || d.purgedAt) return new NextResponse("Not found", { status: 404 });
  const body = decryptBytes(d.data, d.encrypted);
  await logDocAccess([d], "site", null, clientIp(req.headers));
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": d.mime,
      "Content-Length": String(body.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(d.fileName)}`,
    },
  });
}
