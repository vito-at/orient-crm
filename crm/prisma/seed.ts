import { PrismaClient } from "@prisma/client";
import { seedBase } from "./seed-base";
import { seedDemo } from "./seed-demo";

const prisma = new PrismaClient();

async function main() {
  await seedBase(prisma);
  console.log("Seed: справочники и администратор созданы");
  // демо-лиды и менеджеры с паролем manager123 — только по явному SEED_DEMO=true (для разработки), не в боевой базе
  if (process.env.SEED_DEMO === "true") await seedDemo(prisma, Number(process.env.SEED_DEMO_COUNT) || 100);
}

main()
  .catch((e) => {
    console.error(e);
    process.exit(1);
  })
  .finally(() => prisma.$disconnect());
