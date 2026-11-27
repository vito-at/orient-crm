import type { NextConfig } from "next";

/**
 * Заголовки защиты для всех ответов, независимо от прокси перед CRM (HSTS, nosniff, X-Frame-Options и Referrer-Policy
 * ставит Caddy). CSP — только правила, которые не мешают встроенным скриптам Next.js: страницы CRM нельзя встроить
 * в чужой сайт, подменить базовый адрес ссылок (<base>) или отправить форму на чужой адрес. Камера, микрофон,
 * геолокация и оплата в браузере CRM не используются, поэтому отключены.
 */
const securityHeaders = [
  { key: "Content-Security-Policy", value: "frame-ancestors 'none'; base-uri 'self'; form-action 'self'" },
  { key: "Permissions-Policy", value: "camera=(), microphone=(), geolocation=(), payment=()" },
];

const nextConfig: NextConfig = {
  devIndicators: false,
  poweredByHeader: false,
  serverExternalPackages: ["exceljs", "bcryptjs"],
  experimental: {
    serverActions: { bodySizeLimit: "2mb" },
  },
  async headers() {
    return [{ source: "/:path*", headers: securityHeaders }];
  },
};

export default nextConfig;
