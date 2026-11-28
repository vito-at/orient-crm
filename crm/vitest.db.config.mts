import { defineConfig } from "vitest/config";
import path from "path";

// Тесты с настоящей PostgreSQL (DATABASE_URL, миграции применены): npm run test:db. Обычные тесты (npm test) базу не трогают
export default defineConfig({
  resolve: { alias: { "@": path.resolve(import.meta.dirname, "src") } },
  test: { include: ["tests/db/**/*.dbtest.ts"], environment: "node", testTimeout: 60000, hookTimeout: 60000, fileParallelism: false },
});
