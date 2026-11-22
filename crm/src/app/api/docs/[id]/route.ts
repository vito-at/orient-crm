import { NextResponse, type NextRequest } from "next/server";
import { prisma } from "@/lib/db";
import { getCurrentUser, needsTotp } from "@/lib/session";
import { documentScope } from "@/lib/visa";
import { decryptBytes, logDocAccess } from "@/lib/doc-files";
import { clientIp } from "@/lib/login-guard";

export const dynamic = "force-dynamic";

/** Документ клиента — только сотрудникам с доступом к заявке. ?download=1 — скачать */
export async function GET(req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const user = await getCurrentUser();
  if (!user) return new NextResponse("Unauthorized", { status: 401 });
  if (needsTotp(user)) return new NextResponse("Two-factor sign-in required", { status: 403 });
  const { id } = await params;
  const d = await prisma.leadDocument.findFirst({ where: { id, ...documentScope(user) } });
  if (!d) return new NextResponse("Not found", { status: 404 });
  // удалён по сроку хранения после выдачи визы / отказа
  if (d.purgedAt) return new NextResponse("Gone", { status: 410 });
  const download = req.nextUrl.searchParams.get("download") === "1";
  const inline = !download && (/^(image|video|audio)\//.test(d.mime) || d.mime === "application/pdf");
  const body = decryptBytes(d.data, d.encrypted);
  await logDocAccess([d], download ? "download" : "view", user.id, clientIp(req.headers));
  return new NextResponse(new Uint8Array(body), {
    headers: {
      "Content-Type": d.mime,
      "Content-Length": String(body.length),
      "Cache-Control": "private, no-store",
      "X-Content-Type-Options": "nosniff",
      "Content-Security-Policy": "sandbox",
      "Content-Disposition": `${inline ? "inline" : "attachment"}; filename*=UTF-8''${encodeURIComponent(d.fileName)}`,
    },
  });
}
